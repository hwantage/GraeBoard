import { FileImageStore } from "./file-images.mjs";
import { RequestContext } from "../../worker/control.mjs";
import { SqliteControlStore } from "./control-store.mjs";
import { SqliteControlRepository } from "./sqlite-control.mjs";
import {
  PostgresControlRepository,
  bootstrapFromTeamStores,
} from "./postgres-control.mjs";
import { SqliteAdminHistoryRepository } from "./sqlite-admin-history.mjs";
import { requireThat } from "../validation.mjs";
import { PostgresTaskRepository } from "./postgres-tasks.mjs";
import { PostgresDocumentRepository } from "./postgres-documents.mjs";
import { PostgresReportRepository } from "./postgres-reports.mjs";
import { PostgresCalendarRepository } from "./postgres-calendar.mjs";
import { PostgresSettingsRepository } from "./postgres-settings.mjs";
import { PostgresFilterRepository } from "./postgres-filters.mjs";
import { PostgresHistoryRepository } from "./postgres-history.mjs";
import { PostgresDocumentBrowserRepository } from "./postgres-document-browser.mjs";
import { PostgresTransferRepository } from "./postgres-transfer.mjs";
import { PostgresAdminHistoryRepository } from "./postgres-admin-history.mjs";

class NodeTeamControlRepository extends SqliteControlRepository {
  constructor(options, context) {
    super(options);
    this.context = context;
  }
  subscribe(user, teamId, ports) {
    return new PostgresControlRepository({ context: this.context }).subscribe(
      user,
      teamId,
      ports,
    );
  }
  execute(user, command, input = {}, targetId) {
    if (command === "bootstrap") return bootstrapFromTeamStores(this.context);
    if (command === "listUsers") {
      const result = super.execute(user, command, input, targetId);
      return bootstrapFromTeamStores(this.context).then((snapshot) => ({
        ...result,
        teams: snapshot.teams,
      }));
    }
    if (command === "deleteTeam") {
      const row = this.context.controlStore.teamRow(targetId);
      requireThat(
        row?.status !== "active",
        409,
        "팀 업무 DB 연결을 해제하고 백업을 확인한 뒤 삭제하세요.",
      );
    }
    return super.execute(user, command, input, targetId);
  }
}

// Team storage can change independently of host authentication/control. Node
// keeps its password/session/users/memberships together in SQLite. Worker uses
// Access + PostgreSQL control. A Node configuration cannot silently split them.
export function createPostgresBusinessStorage({
  env,
  contextFor,
  imageStoreFor,
} = {}) {
  if (!env)
    throw new TypeError("PostgreSQL team storage requires server-side env");
  let host, controlStore, systemRepository;
  const previewStore = new Map();
  const context = (user, request) => {
    if (!host)
      throw new Error("Business storage must be configured by createApp");
    const selected = contextFor
      ? contextFor(user, request)
      : new RequestContext(
          env,
          user,
          {},
          new Request("http://business.local" + (request?.originalUrl || "/")),
          { waitUntil() {} },
          { controlStore },
        );
    selected.controlStore = controlStore;
    selected.hostAuthMode = "password";
    selected.imageStore = (teamId) =>
      imageStoreFor?.(teamId) ??
      new FileImageStore({ directory: host.documentImagesDir, teamId });
    return selected;
  };
  const result = Object.fromEntries(
    Object.entries({
      tasks: PostgresTaskRepository,
      documents: PostgresDocumentRepository,
      reports: PostgresReportRepository,
      calendar: PostgresCalendarRepository,
      settings: PostgresSettingsRepository,
      filters: PostgresFilterRepository,
      history: PostgresHistoryRepository,
      browser: PostgresDocumentBrowserRepository,
      transfer: PostgresTransferRepository,
    }).map(([key, Repository]) => [
      key,
      (user, request) => new Repository({ context: context(user, request) }),
    ]),
  );
  result.configure = (options) => {
    if (host && host.db !== options.db)
      throw new Error(
        "A business storage instance belongs to one Node control database",
      );
    host = options;
    controlStore = new SqliteControlStore({ db: host.db, env });
    systemRepository = new SqliteAdminHistoryRepository({ db: host.db });
  };
  result.control = Object.assign(
    (user, request) =>
      new NodeTeamControlRepository(host, context(user, request)),
    { authenticationMode: "password" },
  );
  result.adminHistory = (user, request) =>
    new PostgresAdminHistoryRepository({
      context: context(user, request),
      systemRepository,
      previewStore,
    });
  return result;
}
