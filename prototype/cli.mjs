import { createInterface } from "node:readline";
import { createWorkDispatcher } from "../src/work.mjs";

const { dispatch } = createWorkDispatcher();
const input = createInterface({ input: process.stdin, terminal: false });

for await (const line of input) {
  if (line.trim() === "") continue;
  try {
    const request = JSON.parse(line);
    const response = dispatch(request);
    console.log(typeof response === "string" ? response : JSON.stringify(response));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
}
