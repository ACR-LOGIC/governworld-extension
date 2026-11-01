// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Interactive Document Canvas & Redaction Visualizer.
 *
 * Provides:
 * - High-DPI canvas page rendering with simulated document layout
 * - Interactive bounding box selection with category badges
 * - Instant style previewing: Blackout (#000), Whiteout (#FFF), and Text Stamp ([REDACTED])
 * - Pixel Verification Scanline Shader simulating cryptographic proof
 * - Drag-to-redact manual rectangle selection
 */

import type { Finding } from "../types/index.js";

export interface RedactionBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  category: string;
  applied: boolean;
}

export class DocumentVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private boxes: RedactionBox[] = [];
  private isVerifying = false;
  private verifyProgress = 0;
  private currentStyle: "blackout" | "whiteout" | "stamp" = "blackout";
  private stampText = "[REDACTED]";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not acquire 2D context for document canvas");
    this.ctx = context;
    this.initDefaultBoxes();
    this.render();
  }

  public setStyle(style: "blackout" | "whiteout" | "stamp", stampText = "[REDACTED]"): void {
    this.currentStyle = style;
    this.stampText = stampText;
    this.render();
  }

  public setBoxes(findings: Finding[]): void {
    this.boxes = findings.map((f, i) => ({
      id: f.id,
      x: f.location?.rect?.x ?? 80,
      y: f.location?.rect?.y ?? (140 + i * 55),
      width: f.location?.rect?.width ?? 160,
      height: f.location?.rect?.height ?? 24,
      label: f.label,
      category: f.category,
      applied: f.selected,
    }));
    this.render();
  }

  public toggleBox(id: string): void {
    const box = this.boxes.find((b) => b.id === id);
    if (box) {
      box.applied = !box.applied;
      this.render();
    }
  }

  public addManualBox(x: number, y: number, width: number, height: number): void {
    this.boxes.push({
      id: `manual-${Date.now()}`,
      x,
      y,
      width,
      height,
      label: "Manual Box",
      category: "custom",
      applied: true,
    });
    this.render();
  }

  public runPixelVerification(onComplete: (stats: { darkRegions: number; checkedRegions: number }) => void): void {
    this.isVerifying = true;
    this.verifyProgress = 0;

    const interval = setInterval(() => {
      this.verifyProgress += 0.05;
      this.render();

      if (this.verifyProgress >= 1.0) {
        clearInterval(interval);
        this.isVerifying = false;
        const total = this.boxes.filter((b) => b.applied).length;
        onComplete({ darkRegions: total, checkedRegions: total });
      }
    }, 40);
  }

  private initDefaultBoxes(): void {
    this.boxes = [
      { id: "b1", x: 140, y: 160, width: 130, height: 22, label: "SSN", category: "ssn", applied: true },
      { id: "b2", x: 140, y: 220, width: 110, height: 22, label: "MRN", category: "medical_record_number", applied: true },
      { id: "b3", x: 140, y: 310, width: 175, height: 22, label: "Visa Card", category: "payment_card", applied: true },
    ];
  }

  public render(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = 540;
    const height = 700;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.ctx.scale(dpr, dpr);

    // 1. Draw Document Page Sheet (Clean Ivory / White Page)
    this.ctx.fillStyle = "#ffffff";
    this.ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    this.ctx.shadowBlur = 24;
    this.ctx.shadowOffsetY = 8;
    this.ctx.fillRect(20, 20, width - 40, height - 40);
    this.ctx.shadowBlur = 0; // reset

    // 2. Simulated Document Header & Watermark
    this.ctx.fillStyle = "#1e293b";
    this.ctx.font = "bold 16px -apple-system, sans-serif";
    this.ctx.fillText("CLINICAL INTAKE & FINANCIAL GUARANTEE", 45, 65);

    this.ctx.fillStyle = "#64748b";
    this.ctx.font = "11px -apple-system, sans-serif";
    this.ctx.fillText("CONFIDENTIAL PATIENT RECORD — DEPARTMENT OF NEUROLOGY", 45, 84);

    this.ctx.strokeStyle = "#e2e8f0";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(45, 96);
    this.ctx.lineTo(width - 45, 96);
    this.ctx.stroke();

    // 3. Document simulated typography lines
    const textLines = [
      { label: "Patient Full Name:", val: "ELEANOR VANCE", y: 130 },
      { label: "Social Security Number:", val: "•••-••-6789", y: 175 },
      { label: "Medical Record # (MRN):", val: "MRN-99482104", y: 235 },
      { label: "Primary Physician NPI:", val: "NPI-1942058192", y: 290 },
      { label: "Billing Payment Method:", val: "4111-••••-••••-4242", y: 325 },
      { label: "Emergency Contact Phone:", val: "+1 (555) 019-2834", y: 380 },
      { label: "Residential Address:", val: "742 Evergreen Terrace, Springfield", y: 435 },
    ];

    for (const line of textLines) {
      this.ctx.fillStyle = "#475569";
      this.ctx.font = "bold 11px -apple-system, sans-serif";
      this.ctx.fillText(line.label, 45, line.y);

      this.ctx.fillStyle = "#0f172a";
      this.ctx.font = "13px ui-monospace, Consolas, monospace";
      this.ctx.fillText(line.val, 45, line.y + 18);

      // Light underline rule
      this.ctx.strokeStyle = "#f1f5f9";
      this.ctx.beginPath();
      this.ctx.moveTo(45, line.y + 26);
      this.ctx.lineTo(width - 45, line.y + 26);
      this.ctx.stroke();
    }

    // 4. Draw Redaction Boxes (Active or Pending)
    for (const box of this.boxes) {
      if (box.applied) {
        if (this.currentStyle === "blackout") {
          this.ctx.fillStyle = "#090d16";
          this.ctx.fillRect(box.x, box.y, box.width, box.height);
        } else if (this.currentStyle === "whiteout") {
          this.ctx.fillStyle = "#ffffff";
          this.ctx.fillRect(box.x, box.y, box.width, box.height);
          this.ctx.strokeStyle = "#cbd5e1";
          this.ctx.lineWidth = 1;
          this.ctx.strokeRect(box.x, box.y, box.width, box.height);
        } else if (this.currentStyle === "stamp") {
          this.ctx.fillStyle = "#ffffff";
          this.ctx.fillRect(box.x, box.y, box.width, box.height);
          this.ctx.strokeStyle = "#0f172a";
          this.ctx.lineWidth = 1.5;
          this.ctx.strokeRect(box.x, box.y, box.width, box.height);

          this.ctx.fillStyle = "#0f172a";
          this.ctx.font = "bold 10px ui-monospace, sans-serif";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(this.stampText, box.x + box.width / 2, box.y + box.height / 2);
          this.ctx.textAlign = "start";
          this.ctx.textBaseline = "alphabetic";
        }
      } else {
        // Unselected / Candidate box outline
        this.ctx.strokeStyle = "#f59e0b";
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([4, 3]);
        this.ctx.strokeRect(box.x, box.y, box.width, box.height);
        this.ctx.setLineDash([]);
      }
    }

    // 5. Verification Scan Shader Overlay
    if (this.isVerifying) {
      const scanY = 20 + (height - 40) * this.verifyProgress;

      // Completed verification area green tint
      this.ctx.fillStyle = "rgba(16, 185, 129, 0.08)";
      this.ctx.fillRect(20, 20, width - 40, scanY - 20);

      // Scanline beam
      const vGrad = this.ctx.createLinearGradient(0, scanY - 15, 0, scanY + 15);
      vGrad.addColorStop(0, "rgba(16, 185, 129, 0)");
      vGrad.addColorStop(0.5, "rgba(16, 185, 129, 0.7)");
      vGrad.addColorStop(1, "rgba(16, 185, 129, 0)");

      this.ctx.fillStyle = vGrad;
      this.ctx.fillRect(20, scanY - 15, width - 40, 30);

      this.ctx.strokeStyle = "#10b981";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(20, scanY);
      this.ctx.lineTo(width - 20, scanY);
      this.ctx.stroke();
    }
  }
}
