import { db } from "./db";
import { createOwner } from "./modules/auth/service";
import { ApiError } from "./errors";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { integrity } from "./maintenance";

const args = process.argv.slice(2),
  command = args[0];
const option = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
async function password() {
  if (args.includes("--password-stdin")) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += String(chunk);
      if (value.length > 2048) throw new Error("Password input is too long.");
    }
    return value.replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY)
    throw new Error("Use --password-stdin when running without a terminal.");
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    process.stdout.write("Password (at least 12 characters): ");
    hidden = true;
    const first = await reader.question("");
    process.stdout.write("\nConfirm password: ");
    const second = await reader.question("");
    process.stdout.write("\n");
    if (first !== second) throw new Error("Passwords do not match.");
    return first;
  } finally {
    reader.close();
  }
}
async function backup() {
  const child = spawn(
    process.execPath,
    [
      "infra/backup/backup.mjs",
      command === "backup" ? "run" : "verify",
      ...args.slice(1),
    ],
    { stdio: "inherit", env: process.env },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code) process.exitCode = code;
      resolve();
    });
  });
}
try {
  if (command === "create-owner") {
    const email = option("email");
    if (!email)
      throw new Error(
        "Usage: npm run cli -- create-owner --email=you@example.com [--profile=Learning] [--password-stdin]",
      );
    const user = await createOwner({
      email,
      password: await password(),
      profileName: option("profile") ?? "Learning",
    });
    process.stdout.write(`Owner created: ${user.email}\n`);
  } else if (command === "health") {
    await db.$queryRaw`SELECT 1`;
    process.stdout.write("Database connected.\n");
  } else if (command === "worker-health") {
    const heartbeat = await db.systemMeta.findUnique({
      where: { key: "worker-heartbeat" },
    });
    const at = heartbeat ? new Date(String(heartbeat.value)).getTime() : NaN;
    if (!Number.isFinite(at) || Date.now() - at > 180000) process.exitCode = 1;
    else process.stdout.write("Worker heartbeat current.\n");
  } else if (command === "integrity") {
    const result = await integrity();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "backup" || command === "verify-backup")
    await backup();
  else {
    process.stdout.write(
      "Kram CLI\nCommands: create-owner, health, worker-health, integrity, backup --local-only, verify-backup ARCHIVE\n",
    );
    if (command) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ error: { code: error instanceof ApiError ? error.code : "CLI_FAILED", message: error instanceof Error ? error.message : "Command failed." } })}\n`,
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
