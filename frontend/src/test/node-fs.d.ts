// Tests run under Node, but the app's types leave Node out (its timers would
// replace the browser's). This is the one Node API a test uses: reading the
// stylesheet the motion budget checks (src/__tests__/motionBudget.test.ts).
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
