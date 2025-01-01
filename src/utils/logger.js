import kleur from "kleur";

function formatMessage(level, msg) {
  const date = new Date();
  const timestamp = date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `[${timestamp}] [${level}] ${msg}`;
}

export const log = {
  info: (msg) => console.log(kleur.blue(formatMessage("INFO", msg))),
  warn: (msg) => console.log(kleur.yellow(formatMessage("WARN", msg))),
  error: (msg) => console.log(kleur.red(formatMessage("ERROR", msg))),
};
