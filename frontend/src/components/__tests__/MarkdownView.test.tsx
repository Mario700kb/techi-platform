import { render, screen } from "@testing-library/react";
import MarkdownView from "../MarkdownView";

describe("MarkdownView", () => {
  it("never turns page text into HTML or script", () => {
    const { container } = render(
      <MarkdownView source={'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n**<b>bold</b>**'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain('<img src=x onerror="alert(2)">');
  });

  it("links only http(s) and mailto targets", () => {
    const { container } = render(
      <MarkdownView
        source={
          "[docs](https://example.test/a) [bad](javascript:alert(1)) [data](data:text/html,x) [mail](mailto:it@x.test)"
        }
      />,
    );
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.test/a", "mailto:it@x.test"]);
    expect(container.textContent).toContain("bad");
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders headings, lists, checklists, tables, code and quotes", () => {
    const source = [
      "## Network",
      "",
      "- Gateway **10.0.0.1**",
      "- DNS `10.0.0.2`",
      "",
      "1. Restart router",
      "2. Check uplink",
      "",
      "- [x] Backup configured",
      "- [ ] UPS tested",
      "",
      "| Device | Address |",
      "| --- | --- |",
      "| Printer | 10.0.0.50 |",
      "",
      "```",
      "ssh admin@10.0.0.1",
      "```",
      "",
      "> Call the clinic before rebooting.",
    ].join("\n");
    const { container } = render(<MarkdownView source={source} />);

    expect(screen.getByRole("heading", { level: 3, name: "Network" })).toBeInTheDocument();
    expect(container.querySelectorAll("ul > li")).toHaveLength(4);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(screen.getByRole("cell", { name: "10.0.0.50" })).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toBe("ssh admin@10.0.0.1");
    expect(container.querySelector("blockquote")?.textContent).toBe("Call the clinic before rebooting.");
    expect(container.querySelector("strong")?.textContent).toBe("10.0.0.1");
  });
});
