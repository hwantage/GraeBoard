// Loaded with --import into the split cutover commands by
// sheet-clone-split-cutover.test.mjs: each command runs as an operator runs
// it, and only the GitHub address of the fixture repository is served by the
// local bare repository named in SHEET_CLONE_SPLIT_TEST_REMOTE.
import { GitCliTransport } from "../server/sync/git-cli.mjs";

const remote = process.env.SHEET_CLONE_SPLIT_TEST_REMOTE;
if (remote) {
  const init = GitCliTransport.prototype.init;
  GitCliTransport.prototype.init = function () {
    if (this.repository === "https://github.com/fixture/team")
      this.repository = remote;
    return init.call(this);
  };
}
