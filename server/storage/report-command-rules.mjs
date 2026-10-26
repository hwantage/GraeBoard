import {
  applyReportOperation,
  ReportEditError,
} from "../../shared/report-editing.js";
import { propertiesFor } from "../../shared/domain.js";
import {
  validateCellValue,
  validCellKey,
  requireThat,
} from "../validation.mjs";

// Engine-neutral validation + row transformation; adapters supply authorized
// people and hydrated document references and retain their own storage format.
export function prepareReportEdits({
  report,
  operations,
  teamId,
  year,
  actorId,
  available = [],
}) {
  // A copied row may contain archived columns/options that were already
  // present in this report. Keep them without importing the live schema.
  const copySettings = {
    ...report.settings,
    properties: propertiesFor(report.settings, true).map((property) => ({
      ...property,
      archived: false,
      values: property.values.map((option) => ({
        ...option,
        archived: false,
      })),
    })),
  };
  const people = new Map((report.users || []).map((user) => [user.id, user]));
  for (const user of available)
    if (!people.has(user.id))
      people.set(user.id, { id: user.id, name: user.name });
  const assignable = new Set(people.keys());
  let tasks = report.tasks;
  const deleted = new Map();
  let changedCells = 0;
  for (const operation of operations) {
    if (operation.kind === "restore") {
      for (const task of operation.tasks) {
        requireThat(
          task.teamId === teamId,
          400,
          "다른 팀의 업무는 복원할 수 없습니다.",
        );
        for (const [key, cell] of Object.entries(task.cells)) {
          changedCells++;
          validateCellValue(
            null,
            teamId,
            key,
            cell.value,
            copySettings,
            undefined,
            assignable,
          );
        }
      }
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (
      operation.kind === "create" &&
      operation.sourceId &&
      operation.copiedRow?.documents
    ) {
      const source = byId.get(operation.sourceId);
      operation.copiedRow.documents = operation.copiedRow.documents.map(
        (doc) => ({
          ...source?.documents?.find((item) => item.id === doc.id),
          ...doc,
        }),
      );
    }
    if (operation.kind === "cells") {
      changedCells += operation.changes.length;
      for (const change of operation.changes) {
        const task = byId.get(change.taskId);
        requireThat(task, 400, "사본에서 해당 업무를 찾지 못했습니다.");
        validateCellValue(
          null,
          teamId,
          change.key,
          change.value,
          report.settings,
          task.cells[change.key]?.value,
          assignable,
        );
      }
    }
    if (operation.kind === "create")
      for (const [key, value] of Object.entries(operation.fields))
        validateCellValue(
          null,
          teamId,
          key,
          value,
          report.settings,
          undefined,
          assignable,
        );
    if (operation.kind === "create" && operation.copiedRow)
      for (const [key, cell] of Object.entries(operation.copiedRow.cells))
        validateCellValue(
          null,
          teamId,
          key,
          cell.value,
          copySettings,
          undefined,
          assignable,
        );
    if (operation.kind === "format")
      for (const scope of operation.scopes)
        for (const key of [...(scope.keys || []), ...(scope.excludeKeys || [])])
          requireThat(
            validCellKey(key, report.settings),
            400,
            "사본에 없는 속성입니다.",
          );
    requireThat(
      changedCells <= 200000,
      400,
      "한 번에 저장할 사본 변경이 너무 많습니다.",
    );
    try {
      const previous = tasks;
      tasks = applyReportOperation(tasks, operation, {
        teamId: teamId,
        year: year,
        actorId: actorId,
        settings: report.settings,
      });
      const remaining = new Set(tasks.map((task) => task.id));
      for (const task of previous)
        if (!remaining.has(task.id)) deleted.set(task.id, task);
    } catch (error) {
      if (!(error instanceof ReportEditError)) throw error;
      requireThat(false, 400, error.message);
    }
  }

  return { tasks, deleted, people };
}
