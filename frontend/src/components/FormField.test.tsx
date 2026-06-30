import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import FormField from "./FormField";

describe("FormField component", () => {
  it("renders valid fields without aria-describedby attribute", () => {
    const handleChange = vi.fn();
    render(
      <FormField
        label="Username"
        name="username"
        value=""
        onChange={handleChange}
      />
    );

    const input = screen.getByLabelText("Username");
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("links validation error to input via aria-describedby using stable ID derived from name prop", () => {
    const handleChange = vi.fn();
    render(
      <FormField
        label="Email"
        name="email"
        value="bad-email"
        error="Invalid email address"
        onChange={handleChange}
      />
    );

    const input = screen.getByLabelText("Email");
    const errorId = "email-error";

    expect(input.getAttribute("aria-describedby")).toBe(errorId);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    const errorElement = screen.getByRole("alert");
    expect(errorElement.id).toBe(errorId);
    expect(errorElement.textContent).toBe("Invalid email address");
    expect(errorElement.tagName.toLowerCase()).toBe("span");
  });

  it("ensures error element is present in DOM when field is invalid for screen reader announcement", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <FormField
        label="Password"
        name="password"
        value="123"
        error="Password too short"
        onChange={handleChange}
      />
    );

    const errorSpan = container.querySelector("#password-error");
    expect(errorSpan).not.toBeNull();
    expect(errorSpan?.textContent).toBe("Password too short");
  });

  it("passes axe-core accessibility check when valid", async () => {
    const handleChange = vi.fn();
    const { container } = render(
      <FormField
        label="Address"
        name="address"
        value="GBXXX..."
        onChange={handleChange}
      />
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it("passes axe-core accessibility check when invalid", async () => {
    const handleChange = vi.fn();
    const { container } = render(
      <FormField
        label="Address"
        name="address"
        value="invalid"
        error="Address must start with G"
        onChange={handleChange}
      />
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it("matches snapshot when displaying validation error", () => {
    const handleChange = vi.fn();
    const { container } = render(
      <FormField
        label="Amount"
        name="amount"
        value="-10"
        error="Amount cannot be negative"
        onChange={handleChange}
      />
    );

    expect(container).toMatchSnapshot();
  });
});
