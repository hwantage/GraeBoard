import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import {
  AVATARS_FILE,
  avatarFile,
  decodeAvatarImage,
  decodeAvatars,
  publishDirectory,
  teamAvatars,
  validateAvatars,
  validateDirectory,
} from "../../../server/sync/core/directory.mjs";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";

const png = async (background) =>
  "data:image/png;base64," +
  (
    await sharp({
      create: { width: 8, height: 8, channels: 3, background },
    })
      .png()
      .toBuffer()
  ).toString("base64");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const identity = {
    teamId: randomUUID(),
    installationId: randomUUID(),
    repoId: randomUUID(),
  };
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  const directory = {
    format: "graeboard-team-directory",
    version: 1,
    ...identity,
    members: ids.map((id, i) => ({
      id,
      name: "Member " + i,
      email: `m${i}@example.test`,
      active: true,
      role: i ? "member" : "lead",
    })),
  };
  return { identity, ids, directory };
}

test("the avatar list names colour, initials and image hash, skips broken profiles and rejects anything else", async () => {
  const { identity, ids, directory } = fixture(),
    image = await png("#ff0000");
  const avatars = teamAvatars(directory, [
    { id: ids[0], color: "#3a6ea5", avatarInitials: "KJ", avatarImage: "" },
    { id: ids[1], color: "#177b70", avatarInitials: "", avatarImage: image },
    { id: ids[2], color: "red", avatarInitials: "", avatarImage: "" },
  ]);
  assert.deepEqual(avatars.value, {
    format: "graeboard-team-avatars",
    version: 1,
    ...identity,
    members: [
      { id: ids[0], color: "#3a6ea5", initials: "KJ", image: "" },
      { id: ids[1], color: "#177b70", initials: "", image: sha256(image) },
    ],
  });
  assert.deepEqual([...avatars.images], [[ids[1], image]]);
  assert.deepEqual(avatars.skipped, [ids[2]]);
  // The directory itself stays version 1 with its five member keys.
  assert.equal(validateDirectory(directory), directory);
  assert.deepEqual(
    decodeAvatars(Buffer.from(JSON.stringify(avatars.value)), identity),
    avatars.value,
  );
  const broken = (change) => {
    const value = structuredClone(avatars.value);
    change(value);
    return () => validateAvatars(value, identity);
  };
  for (const change of [
    (v) => (v.version = 2),
    (v) => (v.format = "graeboard-team-directory"),
    (v) => (v.extra = true),
    (v) => (v.repoId = randomUUID()),
    (v) => (v.members = Array(1001).fill(v.members[0])),
  ])
    assert.throws(broken(change), /identity or format/);
  for (const change of [
    (v) => (v.members[0].color = "#12345"),
    (v) => (v.members[0].initials = "ABCD"),
    (v) => (v.members[0].initials = " KJ"),
    (v) => (v.members[0].image = "A".repeat(64)),
    (v) => (v.members[0].image = image),
    (v) => (v.members[0].avatarImage = ""),
    (v) => (v.members[0].id = "not-a-uuid"),
    (v) => v.members.push({ ...v.members[0] }),
  ])
    assert.throws(broken(change), /avatar member/);
  assert.equal(decodeAvatarImage(Buffer.from(image), sha256(image)), image);
  const svg =
    "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64");
  for (const [text, hash] of [
    [image, sha256(image + " ")],
    [svg, sha256(svg)],
    ["", sha256("")],
  ])
    assert.throws(
      () => decodeAvatarImage(Buffer.from(text), hash),
      /avatar image/,
    );
});

test("publishing writes a changed image once, leaves unchanged images and directory.json untouched and survives an older publisher", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gb-avatars-")),
    remote = join(dir, "remote.git");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const transport = () =>
    new GitCliTransport({
      directory: join(dir, "cache-" + randomUUID() + ".git"),
      repository: remote,
      allowLocal: true,
    });
  const git = (...args) =>
    execFileSync("git", ["-C", remote, ...args])
      .toString()
      .trim();
  const { ids, directory } = fixture(),
    branch = "sync-directory/" + directory.installationId,
    red = await png("#ff0000"),
    blue = await png("#0000ff");
  const profiles = [
    { id: ids[0], color: "#3a6ea5", avatarInitials: "KJ", avatarImage: "" },
    { id: ids[1], color: "#177b70", avatarInitials: "", avatarImage: red },
    { id: ids[2], color: "#177b70", avatarInitials: "", avatarImage: blue },
  ];
  const publish = (value = directory) =>
    publishDirectory(transport(), value, teamAvatars(value, profiles));
  const changed = (from, to) =>
    git("diff", "--name-only", from, to).split("\n").filter(Boolean).sort();
  const first = await publish();
  assert.deepEqual(
    git("ls-tree", "-r", "--name-only", first).split("\n").sort(),
    [AVATARS_FILE, avatarFile(ids[1]), avatarFile(ids[2]), "directory.json"],
  );
  assert.equal(git("show", `${first}:${avatarFile(ids[1])}`), red);
  assert.deepEqual(
    Object.keys(JSON.parse(git("show", `${first}:directory.json`)).members[0]),
    ["active", "email", "id", "name", "role"],
  );
  // Unchanged: a fresh publisher (no cache) verifies and writes nothing.
  assert.equal(await publish(), first);
  assert.equal(git("rev-parse", branch), first);
  // A colour change rewrites the list only.
  profiles[0].color = "#000000";
  const colour = await publish();
  assert.deepEqual(changed(first, colour), [AVATARS_FILE]);
  // A new picture writes that member's image and the list.
  profiles[1].avatarImage = blue;
  const picture = await publish();
  assert.deepEqual(changed(colour, picture), [
    AVATARS_FILE,
    avatarFile(ids[1]),
  ]);
  // Removing a picture empties its file in the newest tree.
  profiles[2].avatarImage = "";
  const removed = await publish();
  assert.deepEqual(changed(picture, removed), [
    AVATARS_FILE,
    avatarFile(ids[2]),
  ]);
  assert.equal(git("show", `${removed}:${avatarFile(ids[2])}`), "");
  // A name change leaves avatars.json and every image as they were.
  const renamed = structuredClone(directory);
  renamed.members[0].name = "Renamed";
  const name = await publish(renamed);
  assert.deepEqual(changed(removed, name), ["directory.json"]);
  // A publisher from before avatars keeps the avatar files of its parent.
  renamed.members[1].role = "viewer";
  const older = await publishDirectory(transport(), renamed);
  assert.deepEqual(changed(name, older), ["directory.json"]);
  assert.equal(git("show", `${older}:${avatarFile(ids[1])}`), blue);
});
