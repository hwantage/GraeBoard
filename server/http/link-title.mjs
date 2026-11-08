import { createLinkTitleService } from "../../shared/http/link-title.mjs";
import { requireThat } from "../../shared/http/http-error.js";

export function installLinkTitleRoute(app, options) {
  const title = createLinkTitleService(options);
  app.get("/api/link-title", async (req, res) => {
    requireThat(
      req.get("X-Requested-With") === "WeeklyPlan",
      403,
      "요청 출처를 확인할 수 없습니다.",
    );
    res.json(await title(req.user.id, req.query.url));
  });
}
