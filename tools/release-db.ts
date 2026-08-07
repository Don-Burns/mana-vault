/// <reference lib="deno.ns" />

/**
 * Publish the locally-built hash DB as a GitHub Release asset, so the
 * `deploy.yml` CI workflow can download it without running the multi-hour
 * Scryfall bulk-art pipeline itself.
 *
 * Usage: deno task db:release (runs after db:download / db:art / db:build)
 *
 * Overwrites a single moving `db-latest` release/tag rather than minting a
 * new versioned tag each time — simplest thing that lets CI always fetch
 * "the current DB" with no workflow edits required per release. If per-build
 * history/rollback is ever needed, switch this to a timestamped tag and
 * update `db-latest` in `deploy.yml` to match.
 */

const TAG = "db-latest";
const FILES = ["public/db/hash-db.bin", "public/db/metadata.json", "public/db/version.json"];

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "inherit", stderr: "inherit" });
  const { success } = await p.output();
  if (!success) throw new Error(`command failed: ${cmd.join(" ")}`);
}

async function main() {
  for (const f of FILES) {
    try {
      await Deno.stat(f);
    } catch {
      console.error(`Missing ${f} — run db:build first.`);
      Deno.exit(1);
    }
  }

  // `gh release upload` fails if the tag doesn't exist yet, and there's no
  // "upsert" flag, so create-or-noop then delete+reupload the assets.
  const createResult = await new Deno.Command("gh", {
    args: ["release", "view", TAG],
    stdout: "null",
    stderr: "null",
  }).output();

  if (!createResult.success) {
    await run(["gh", "release", "create", TAG, "--title", "Hash DB (latest)", "--notes", "Auto-published by deno task db:release"]);
  } else {
    await run(["gh", "release", "upload", TAG, ...FILES, "--clobber"]);
    console.log(`Updated release ${TAG} with ${FILES.join(", ")}`);
    return;
  }

  await run(["gh", "release", "upload", TAG, ...FILES, "--clobber"]);
  console.log(`Published release ${TAG} with ${FILES.join(", ")}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
