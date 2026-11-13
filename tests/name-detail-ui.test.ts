// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderFindings } from "../src/popup/popup.js";
import type { Finding } from "../src/shared/types.js";

function finding(category: string, value: string, parsedName?: any): Finding {
  return {
    id: `${category}_0_5_0`,
    category: category as any,
    entityType: "patient_name",
    confidence: 0.8,
    source: "local-rules",
    preview: "********",
    nodeId: "node-0",
    startOffset: 0,
    endOffset: 5,
    rects: [],
    contextPreview: "* * * * *",
    selected: true,
    ...(parsedName ? { parsedName } : {}),
  };
}

function textOf(el: Element | null): string {
  return el ? el.textContent ?? "" : "";
}

describe("name detail UI rendering (possible_name)", () => {
  it("renders structured name components under a possible_name finding", () => {
    document.body.innerHTML = `<ul id="findings-list"></ul><span id="results-count"></span><button id="apply-masks-btn"></button>`;
    const parsed = {
      prefix: "Dr",
      first: "Mary",
      middle: ["Jane"],
      last: "Smith",
      suffix: null,
      credentials: ["MD"],
      gender: null,
      age: null,
      dob: null,
      rawName: "Mary Jane Smith",
      rawInput: "Mary Jane Smith",
      tokens: ["Mary", "Jane", "Smith"],
    };
    renderFindings([finding("possible_name", "Mary Jane Smith", parsed)]);
    const detail = document.querySelector(".finding__name-detail");
    expect(detail).not.toBeNull();
    expect(textOf(detail)).toContain("Title: Dr");
    expect(textOf(detail)).toContain("First: Mary");
    expect(textOf(detail)).toContain("Middle: Jane");
    expect(textOf(detail)).toContain("Last: Smith");
    expect(textOf(detail)).toContain("Credentials: MD");
  });

  it("renders age, gender and DOB context when present", () => {
    document.body.innerHTML = `<ul id="findings-list"></ul><span id="results-count"></span><button id="apply-masks-btn"></button>`;
    const parsed = {
      prefix: null,
      first: "Mary",
      middle: [],
      last: null,
      suffix: null,
      credentials: [],
      gender: "F",
      age: 65,
      dob: "04/22/1990",
      rawName: "Mary F. 65",
      rawInput: "Mary F. 65",
      tokens: ["Mary", "F.", "65"],
    };
    renderFindings([finding("possible_name", "Mary F. 65", parsed)]);
    const detail = document.querySelector(".finding__name-detail");
    expect(textOf(detail)).toContain("Gender: F");
    expect(textOf(detail)).toContain("Age: 65");
    expect(textOf(detail)).toContain("DOB: 04/22/1990");
  });

  it("does not render a name detail for non-name categories", () => {
    document.body.innerHTML = `<ul id="findings-list"></ul><span id="results-count"></span><button id="apply-masks-btn"></button>`;
    renderFindings([finding("ssn", "123-45-6789")]);
    expect(document.querySelector(".finding__name-detail")).toBeNull();
  });

  it("does not render a name detail when parsedName is absent", () => {
    document.body.innerHTML = `<ul id="findings-list"></ul><span id="results-count"></span><button id="apply-masks-btn"></button>`;
    renderFindings([finding("possible_name", "Jane Doe")]);
    expect(document.querySelector(".finding__name-detail")).toBeNull();
  });

  it("renders name details for multiple name findings", () => {
    document.body.innerHTML = `<ul id="findings-list"></ul><span id="results-count"></span><button id="apply-masks-btn"></button>`;
    const p1 = { first: "John", middle: [], last: "Doe", prefix: null, suffix: null, credentials: [], gender: null, age: null, dob: null, rawName: "John Doe", rawInput: "John Doe", tokens: ["John", "Doe"] };
    const p2 = { first: "Maria", middle: ["De", "La"], last: "Cruz", prefix: null, suffix: null, credentials: [], gender: null, age: null, dob: null, rawName: "Maria De La Cruz", rawInput: "Maria De La Cruz", tokens: ["Maria", "De", "La", "Cruz"] };
    renderFindings([finding("possible_name", "John Doe", p1), finding("possible_name", "Maria De La Cruz", p2)]);
    const details = document.querySelectorAll(".finding__name-detail");
    expect(details).toHaveLength(2);
    expect(textOf(details[0])).toContain("First: John");
    expect(textOf(details[1])).toContain("Middle: De, La");
    expect(textOf(details[1])).toContain("Last: Cruz");
  });
});
