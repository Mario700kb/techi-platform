import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TablePagination, { pageNumbers } from "../TablePagination";

describe("pageNumbers", () => {
  it("lists every page when there are seven or fewer", () => {
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps seven slots and never hides a single page behind a gap", () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5, null, 20]);
    expect(pageNumbers(4, 20)).toEqual([1, 2, 3, 4, 5, null, 20]);
    expect(pageNumbers(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageNumbers(17, 20)).toEqual([1, null, 16, 17, 18, 19, 20]);
    expect(pageNumbers(20, 20)).toEqual([1, null, 16, 17, 18, 19, 20]);
  });
});

describe("TablePagination", () => {
  it("shows the range of the current page and pages through", () => {
    const onPageChange = vi.fn();
    render(<TablePagination page={2} pageSize={20} total={327} itemLabel="alerts" onPageChange={onPageChange} />);

    expect(screen.getByText("Showing 21–40 of 327 alerts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables both arrows on a single page and says when there is nothing", () => {
    render(<TablePagination page={1} pageSize={20} total={0} itemLabel="devices" onPageChange={vi.fn()} />);

    expect(screen.getByText("No devices")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
});
