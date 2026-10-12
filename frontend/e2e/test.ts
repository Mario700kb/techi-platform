import { expect, test as base } from "@playwright/test";
import { mockApi, MockState } from "./mockApi";

/**
 * `test` with the mock API installed (signed in as the owner unless a test
 * says otherwise) and a guard that fails the test on any uncaught page
 * error — the kind that shows a user the error boundary.
 */
export const test = base.extend<{ api: MockState; signedOut: boolean }>({
  signedOut: [false, { option: true }],
  // auto: installed for every test, including ones that never touch `api`.
  api: [
    async ({ page, signedOut }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const state = await mockApi(page, signedOut ? { user: null } : {});
      await use(state);
      expect(errors, "uncaught errors in the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
