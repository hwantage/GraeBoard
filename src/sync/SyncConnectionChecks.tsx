import type { ConnectionCheck } from "./sync-connection-types";

export function ConnectionChecks({
  result,
}: {
  result: ConnectionCheck | null;
}) {
  if (!result) return null;
  return (
    <div className="settings-table-scroll">
      <table className="settings-table connection-checks-table">
        <caption>연결 검사 결과</caption>
        <thead>
          <tr>
            <th scope="col">대상</th>
            <th scope="col">결과</th>
            <th scope="col">내용</th>
          </tr>
        </thead>
        <tbody>
          {result.checks.map((check, index) => (
            <tr key={`${check.name}-${index}`}>
              <th scope="row">{check.name}</th>
              <td className={`connection-check-result is-${check.status}`}>
                {check.status === "ok"
                  ? "정상"
                  : check.status === "pending"
                    ? "대기"
                    : "오류"}
              </td>
              <td>{check.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
