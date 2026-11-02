// @vitest-environment jsdom
//
// The sidepanel transform moves the category heading into a <legend> inside
// #category-list. renderCategories() used to call replaceChildren() on the
// fieldset, which deleted that legend and left the generated sidepanel with an
// unlabelled checkbox group.
import { describe, expect, it } from "vitest";
import { renderCategories } from "../src/popup/popup.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";

describe("category rendering", () => {
  it("preserves the sidepanel legend while rebuilding the checkboxes", async () => {
    document.body.innerHTML = `
      <fieldset id="category-list" class="category-fieldset">
        <legend data-i18n="categories_label">Protection Categories</legend>
      </fieldset>`;

    await renderCategories({ enabledCategories: ["email"], language: "en" });

    const legend = document.querySelector("#category-list > legend");
    expect(legend?.textContent).toBe("Protection Categories");
    expect(document.querySelectorAll("#category-list label")).toHaveLength(
      ALL_CATEGORIES.length
    );
  });
});
