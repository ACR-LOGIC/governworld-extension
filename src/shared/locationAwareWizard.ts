/**
 * GovernWorld — Location-Aware Custom Detection
 *
 * Learns stable, normalized page regions from user-approved selections.
 * This module is deterministic and has no browser, network, or storage access.
 *
 * IMPORTANT:
 * - Coordinates are normalized to page dimensions.
 * - Raw document text must never be stored in a LocationRule.
 * - A location match is a candidate, not authorization to redact.
 * - Human approval is required before saving or activating a rule.
 */

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionSample {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  rect: PageRect;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocationRule {
  version: 1;
  strategy: "location";
  sampleCount: number;
  pageAspectRatio: number;
  region: NormalizedRect;
  tolerance: {
    center: number;
    sizeRatio: number;
  };
  confidence: number;
  requiresReview: true;
}

export interface LocationAnalysis {
  eligible: boolean;
  rule?: LocationRule;
  reasons: string[];
}

export interface LocationCandidate {
  matched: boolean;
  confidence: number;
  candidateRect: PageRect;
  reason: string;
}

const MIN_SAMPLES = 3;
const MAX_ASPECT_RATIO_DEVIATION = 0.035;
const MAX_CENTER_DEVIATION = 0.025;
const MAX_SIZE_VARIATION = 0.30;

function normalizeRect(
  rect: PageRect,
  pageWidth: number,
  pageHeight: number
): NormalizedRect {
  if (
    pageWidth <= 0 ||
    pageHeight <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("Invalid page or selection dimensions.");
  }

  return {
    x: rect.x / pageWidth,
    y: rect.y / pageHeight,
    width: rect.width / pageWidth,
    height: rect.height / pageHeight,
  };
}

function center(rect: NormalizedRect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (value - average) ** 2))
  );
}

function coefficientOfVariation(values: number[]): number {
  const average = mean(values);
  if (average === 0) return Infinity;
  return deviation(values) / average;
}

/**
 * Infer a location rule from selections made on separate pages.
 * Require at least three examples from distinct pages.
 */
export function inferLocationRule(
  samples: SelectionSample[]
): LocationAnalysis {
  const reasons: string[] = [];

  if (samples.length < MIN_SAMPLES) {
    return {
      eligible: false,
      reasons: [`Select at least ${MIN_SAMPLES} examples.`],
    };
  }

  const pageNumbers = new Set(samples.map((sample) => sample.pageNumber));

  if (pageNumbers.size < MIN_SAMPLES) {
    return {
      eligible: false,
      reasons: ["Examples must come from at least three distinct pages."],
    };
  }

  let normalized: NormalizedRect[];

  try {
    normalized = samples.map((sample) =>
      normalizeRect(
        sample.rect,
        sample.pageWidth,
        sample.pageHeight
      )
    );
  } catch {
    return {
      eligible: false,
      reasons: ["One or more selections have invalid dimensions."],
    };
  }

  const aspectRatios = samples.map(
    (sample) => sample.pageWidth / sample.pageHeight
  );

  const averageAspectRatio = mean(aspectRatios);

  const aspectDeviation = Math.max(
    ...aspectRatios.map(
      (ratio) => Math.abs(ratio - averageAspectRatio) / averageAspectRatio
    )
  );

  if (aspectDeviation > MAX_ASPECT_RATIO_DEVIATION) {
    reasons.push(
      "The sample pages have different proportions. A single location rule may not be reliable."
    );
  }

  const centers = normalized.map(center);

  const averageCenter = {
    x: mean(centers.map((point) => point.x)),
    y: mean(centers.map((point) => point.y)),
  };

  const centerDeviation = Math.max(
    ...centers.map((point) =>
      Math.hypot(
        point.x - averageCenter.x,
        point.y - averageCenter.y
      )
    )
  );

  if (centerDeviation > MAX_CENTER_DEVIATION) {
    reasons.push(
      "The selected examples do not occupy a sufficiently consistent page location."
    );
  }

  const widths = normalized.map((rect) => rect.width);
  const heights = normalized.map((rect) => rect.height);

  const widthVariation = coefficientOfVariation(widths);
  const heightVariation = coefficientOfVariation(heights);

  if (
    widthVariation > MAX_SIZE_VARIATION ||
    heightVariation > MAX_SIZE_VARIATION
  ) {
    reasons.push(
      "The selected regions vary too much in size."
    );
  }

  if (reasons.length > 0) {
    return { eligible: false, reasons };
  }

  const region: NormalizedRect = {
    x: mean(normalized.map((rect) => rect.x)),
    y: mean(normalized.map((rect) => rect.y)),
    width: mean(widths),
    height: mean(heights),
  };

  const centerScore = Math.max(
    0,
    1 - centerDeviation / MAX_CENTER_DEVIATION
  );

  const sizeScore = Math.max(
    0,
    1 - Math.max(widthVariation, heightVariation) / MAX_SIZE_VARIATION
  );

  const aspectScore = Math.max(
    0,
    1 - aspectDeviation / MAX_ASPECT_RATIO_DEVIATION
  );

  const confidence =
    Math.round(
      ((centerScore * 0.5 + sizeScore * 0.3 + aspectScore * 0.2) *
        100)
    ) / 100;

  return {
    eligible: true,
    reasons: [
      "Selections occupy a consistent normalized page location.",
      "Page proportions and selection dimensions are sufficiently consistent.",
      "This is a location candidate and still requires user review.",
    ],
    rule: {
      version: 1,
      strategy: "location",
      sampleCount: samples.length,
      pageAspectRatio: averageAspectRatio,
      region,
      tolerance: {
        center: MAX_CENTER_DEVIATION,
        sizeRatio: MAX_SIZE_VARIATION,
      },
      confidence,
      requiresReview: true,
    },
  };
}

/**
 * Test a proposed location against a page.
 * Returns a candidate rectangle, never a redaction instruction.
 */
export function matchLocation(
  rule: LocationRule,
  pageWidth: number,
  pageHeight: number
): LocationCandidate {
  if (pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("Invalid target page dimensions.");
  }

  const targetAspectRatio = pageWidth / pageHeight;

  const aspectDeviation =
    Math.abs(targetAspectRatio - rule.pageAspectRatio) /
    rule.pageAspectRatio;

  const candidateRect: PageRect = {
    x: rule.region.x * pageWidth,
    y: rule.region.y * pageHeight,
    width: rule.region.width * pageWidth,
    height: rule.region.height * pageHeight,
  };

  if (aspectDeviation > MAX_ASPECT_RATIO_DEVIATION) {
    return {
      matched: false,
      confidence: 0,
      candidateRect,
      reason: "Page proportions differ from the approved samples.",
    };
  }

  return {
    matched: true,
    confidence: rule.confidence,
    candidateRect,
    reason:
      "Page location is consistent with the approved examples. Review before redaction.",
  };
}
