// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Canvas-based Real-Time Scanning Visualizer.
 *
 * Implements high-performance procedural animation for page scanning:
 * - Oscillating cybernetic laser beam with dual glow falloff
 * - Particle collision markers on detected sensitive coordinates
 * - Dynamic telemetry heads-up display (visible chars & node traversal count)
 * - Zero CPU load when idle / stopped
 */

export class ScanVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrameId: number | null = null;
  private beamY = 0;
  private beamDir = 1;
  private isScanning = false;
  private particles: { x: number; y: number; alpha: number; radius: number; color: string }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not acquire 2D canvas context");
    this.ctx = context;
    this.resize();
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = (rect.width || 380) * dpr;
    this.canvas.height = (rect.height || 220) * dpr;
    this.ctx.scale(dpr, dpr);
  }

  public start(): void {
    if (this.isScanning) return;
    this.isScanning = true;
    this.beamY = 0;
    this.particles = [];
    this.animate();
  }

  public stop(): void {
    this.isScanning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.clear();
  }

  public addHit(xRatio: number, yRatio: number, severity: "critical" | "high" | "medium" = "critical"): void {
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    const colors = {
      critical: "#ef4444",
      high: "#f59e0b",
      medium: "#3b82f6",
    };
    this.particles.push({
      x: xRatio * width,
      y: yRatio * height,
      alpha: 1.0,
      radius: 4,
      color: colors[severity],
    });
  }

  private clear(): void {
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, width, height);
  }

  private animate = (): void => {
    if (!this.isScanning) return;

    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);

    // Trail fade
    this.ctx.fillStyle = "rgba(9, 13, 22, 0.25)";
    this.ctx.fillRect(0, 0, width, height);

    // Grid coordinates background
    this.ctx.strokeStyle = "rgba(148, 163, 184, 0.04)";
    this.ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 30) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
    for (let y = 0; y < height; y += 30) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }

    // Move scanning beam
    this.beamY += this.beamDir * 2.5;
    if (this.beamY >= height) {
      this.beamY = height;
      this.beamDir = -1;
    } else if (this.beamY <= 0) {
      this.beamY = 0;
      this.beamDir = 1;
    }

    // Draw radiant laser beam
    const gradient = this.ctx.createLinearGradient(0, this.beamY - 12, 0, this.beamY + 12);
    gradient.addColorStop(0, "rgba(6, 182, 212, 0)");
    gradient.addColorStop(0.5, "rgba(6, 182, 212, 0.85)");
    gradient.addColorStop(1, "rgba(6, 182, 212, 0)");

    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, this.beamY - 12, width, 24);

    // Laser core line
    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = 2;
    this.ctx.shadowColor = "#06b6d4";
    this.ctx.shadowBlur = 12;
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.beamY);
    this.ctx.lineTo(width, this.beamY);
    this.ctx.stroke();
    this.ctx.shadowBlur = 0; // reset

    // Draw and decay detection hit particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.alpha -= 0.015;
      p.radius += 0.35;

      this.ctx.strokeStyle = p.color;
      this.ctx.lineWidth = 1.5;
      this.ctx.globalAlpha = Math.max(0, p.alpha);

      // Target reticle
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius * 2, 0, Math.PI * 2);
      this.ctx.stroke();

      this.ctx.fillStyle = p.color;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      this.ctx.fill();

      this.ctx.globalAlpha = 1.0;

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
      }
    }

    this.animFrameId = requestAnimationFrame(this.animate);
  };
}
