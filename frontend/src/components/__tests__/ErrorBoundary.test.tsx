import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ErrorBoundary, { isChunkLoadError } from "../ErrorBoundary";
import { NotFound } from "../../pages/StatusPages";

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("render failed");
  return <div>Page content</div>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a recoverable message instead of a blank page", () => {
    render(
      <ErrorBoundary>
        <Boom fail />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on this page");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("clears the error when the reset key changes (navigation)", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom fail />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(
      <ErrorBoundary resetKey="/b">
        <Boom fail={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("retries rendering on Try again", () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("once");
      return <div>Recovered</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });

  it("recognises stale lazy-chunk errors from each browser", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("x is undefined"))).toBe(false);
  });
});

describe("NotFound", () => {
  it("renders for unknown paths", () => {
    render(
      <MemoryRouter initialEntries={["/remote-support"]}>
        <Routes>
          <Route path="/" element={<div>Dashboard</div>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /go to dashboard/i }));
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });
});
