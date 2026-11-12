import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists; preserved.");
} else {
  const template = readFileSync(".env.example", "utf8");
  writeFileSync(
    ".env",
    template.replaceAll("replace-with-local-random-password", randomBytes(24).toString("hex")),
    { flag: "wx" },
  );
  console.log("Created .env with a random local database password.");
}
