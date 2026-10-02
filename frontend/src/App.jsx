import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const getPinPartId = (pin) => pin.part_id ?? pin.part;

const normalizeAngle = (angle) => {
  const value = angle % 360;
  return value < 0 ? value + 360 : value;
};

function transformVector(dx, dy, rotation, flipX, flipY) {
  let x = dx;
  let y = dy;

  if (flipX) x = -x;
  if (flipY) y = -y;

  const angle = normalizeAngle(rotation);
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

function inverseTransformVector(dx, dy, rotation, flipX, flipY) {
  const angle = normalizeAngle(rotation);
  const radians = (-angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  let x = dx * cos - dy * sin;
  let y = dx * sin + dy * cos;

  if (flipX) x = -x;
  if (flipY) y = -y;

  return { x, y };
}

function getFitScale(width, height, boardWidth, boardHeight, rotation) {
  const angle = normalizeAngle(rotation);
  const quarterTurn = angle === 90 || angle === 270;

  const displayWidth = quarterTurn ? boardHeight : boardWidth;
  const displayHeight = quarterTurn ? boardWidth : boardHeight;

  const padding = 70;

  return Math.min(
    (width - padding * 2) / Math.max(1, displayWidth),
    (height - padding * 2) / Math.max(1, displayHeight),
  );
}

function PCBCanvas({
  board,
  selectedPart,
  selectedNet,
  selectedPad,
  activeLayer,
  rotation,
  flipX,
  flipY,
  onSelectPart,
  onSelectPad,
  onRotate,
  onFlipX,
  onFlipY,
}) {
  const canvasRef = useRef(null);

  const [view, setView] = useState({
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });

  const dragRef = useRef(null);

  const partMap = useMemo(() => {
    const map = new Map();

    for (const part of board.parts) {
      map.set(Number(part.id), part);
    }

    return map;
  }, [board]);

  const partBounds = useMemo(() => {
    const bounds = new Map();

    for (const part of board.parts) {
      if (part.bounds) {
        bounds.set(Number(part.id), {
          minX: Number(part.bounds.min_x ?? 0),
          maxX: Number(part.bounds.max_x ?? 0),
          minY: Number(part.bounds.min_y ?? 0),
          maxY: Number(part.bounds.max_y ?? 0),
        });
      }
    }

    for (const pin of board.pins) {
      const partId = Number(getPinPartId(pin));
      if (!Number.isFinite(partId)) continue;

      if (!bounds.has(partId)) {
        bounds.set(partId, {
          minX: pin.x,
          maxX: pin.x,
          minY: pin.y,
          maxY: pin.y,
        });
        continue;
      }

      const box = bounds.get(partId);
      box.minX = Math.min(box.minX, pin.x);
      box.maxX = Math.max(box.maxX, pin.x);
      box.minY = Math.min(box.minY, pin.y);
      box.maxY = Math.max(box.maxY, pin.y);
    }

    return bounds;
  }, [board]);

  const padMetricsByPart = useMemo(() => {
    const metrics = new Map();
    const pinsByPart = new Map();

    for (const pin of board.pins) {
      const partId = Number(getPinPartId(pin));
      if (!Number.isFinite(partId)) continue;

      if (!pinsByPart.has(partId)) {
        pinsByPart.set(partId, []);
      }

      pinsByPart.get(partId).push(pin);
    }

    for (const [partId, pins] of pinsByPart) {
      if (pins.length <= 1) {
        metrics.set(partId, 6);
        continue;
      }

      const xs = pins
        .map((pin) => pin.x)
        .sort((a, b) => a - b);

      const ys = pins
        .map((pin) => pin.y)
        .sort((a, b) => a - b);

      let nearestX = Infinity;
      let nearestY = Infinity;

      for (let i = 1; i < xs.length; i += 1) {
        const gap = Math.abs(xs[i] - xs[i - 1]);
        if (gap > 0) nearestX = Math.min(nearestX, gap);
      }

      for (let i = 1; i < ys.length; i += 1) {
        const gap = Math.abs(ys[i] - ys[i - 1]);
        if (gap > 0) nearestY = Math.min(nearestY, gap);
      }

      const spacing = Math.min(nearestX, nearestY);
      metrics.set(
        partId,
        Number.isFinite(spacing) ? spacing : 6,
      );
    }

    return metrics;
  }, [board]);

  const boardInfo = useMemo(() => {
    const points = board.format_points || [];

    if (!points.length) {
      return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    };
  }, [board]);

  const getScreenPoint = (x, y, rect, scale, info) => {
    const transformed = transformVector(
      x - info.centerX,
      y - info.centerY,
      rotation,
      flipX,
      flipY,
    );

    return {
      x: rect.width / 2 + view.offsetX + transformed.x * scale,
      y: rect.height / 2 + view.offsetY + transformed.y * scale,
    };
  };

  const focusPart = (part) => {
    if (!part || !boardInfo) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const box = partBounds.get(Number(part.id));
    if (!box) return;

    const fitScale = getFitScale(
      rect.width,
      rect.height,
      boardInfo.width,
      boardInfo.height,
      rotation,
    );

    const partWidth = Math.max(1, box.maxX - box.minX);
    const partHeight = Math.max(1, box.maxY - box.minY);
    const partRatio = Math.max(
      0.0001,
      Math.min(
        partWidth / boardInfo.width,
        partHeight / boardInfo.height,
      ),
    );

    const desiredScreenRatio = 0.16;
    const zoom = Math.max(
      1.5,
      Math.min(30, desiredScreenRatio / partRatio),
    );

    const partCenterX = (box.minX + box.maxX) / 2;
    const partCenterY = (box.minY + box.maxY) / 2;

    const transformed = transformVector(
      partCenterX - boardInfo.centerX,
      partCenterY - boardInfo.centerY,
      rotation,
      flipX,
      flipY,
    );

    const zoomedScale = fitScale * zoom;

    setView({
      zoom,
      offsetX: -transformed.x * zoomedScale,
      offsetY: -transformed.y * zoomedScale,
    });
  };

  useEffect(() => {
    if (!selectedPart) return;
    focusPart(selectedPart);
  }, [selectedPart, rotation, flipX, flipY, boardInfo, partBounds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const width = rect.width;
      const height = rect.height;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, width, height);

      if (!boardInfo) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "18px Arial";
        ctx.fillText("No board geometry found", 30, 40);
        return;
      }

      const fitScale = getFitScale(
        width,
        height,
        boardInfo.width,
        boardInfo.height,
        rotation,
      );

      const scale = fitScale * view.zoom;

      const screenPoint = (x, y) =>
        getScreenPoint(x, y, rect, scale, boardInfo);

      // ---------------------------------
      // BOARD OUTLINE
      // ---------------------------------
      const points = board.format_points || [];

      ctx.beginPath();

      points.forEach((point, index) => {
        const screen = screenPoint(point.x, point.y);

        if (index === 0) {
          ctx.moveTo(screen.x, screen.y);
        } else {
          ctx.lineTo(screen.x, screen.y);
        }
      });

      ctx.closePath();
      ctx.fillStyle = "#263238";
      ctx.fill();
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.stroke();

      const selectedPartId = Number(selectedPart?.id);
      const selectedNetName = selectedNet?.net;
      const selectedPadIndex = selectedPad?.index;

      // ---------------------------------
      // COMPONENT BODIES
      // ---------------------------------
      for (const part of board.parts) {
        const partId = Number(part.id);

        if (
          activeLayer !== "Both" &&
          part.mounting_side !== activeLayer
        ) {
          continue;
        }

        const box = partBounds.get(partId);
        if (!box) continue;

        const bodyPadding = 6;
        const corners = [
          [box.minX - bodyPadding, box.minY - bodyPadding],
          [box.maxX + bodyPadding, box.minY - bodyPadding],
          [box.maxX + bodyPadding, box.maxY + bodyPadding],
          [box.minX - bodyPadding, box.maxY + bodyPadding],
        ].map(([x, y]) => screenPoint(x, y));

        const minSX = Math.min(...corners.map((point) => point.x));
        const maxSX = Math.max(...corners.map((point) => point.x));
        const minSY = Math.min(...corners.map((point) => point.y));
        const maxSY = Math.max(...corners.map((point) => point.y));

        const visibleWidth = Math.max(6, maxSX - minSX);
        const visibleHeight = Math.max(6, maxSY - minSY);

        const isSelected = selectedPartId === partId;

        ctx.beginPath();
        ctx.roundRect(
          minSX,
          minSY,
          visibleWidth,
          visibleHeight,
          2,
        );

        if (isSelected) {
          ctx.fillStyle = "rgba(250, 204, 21, 0.24)";
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 2.5;
        } else if (part.mounting_side === "Bottom") {
          ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
          ctx.strokeStyle = "#60a5fa";
          ctx.lineWidth = 0.8;
        } else {
          ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
          ctx.strokeStyle = "#f87171";
          ctx.lineWidth = 0.8;
        }

        ctx.fill();
        ctx.stroke();

        if (visibleWidth > 18 && visibleHeight > 8) {
          ctx.fillStyle = isSelected ? "#ffffff" : "#cbd5e1";
          ctx.font = isSelected ? "bold 10px Arial" : "9px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            part.name,
            minSX + visibleWidth / 2,
            minSY + visibleHeight / 2,
          );
          ctx.textAlign = "start";
          ctx.textBaseline = "alphabetic";
        }
      }

      // ---------------------------------
      // PADS / PINS
      // ---------------------------------
      for (const pin of board.pins) {
        const partId = Number(getPinPartId(pin));
        const part = partMap.get(partId);

        if (!part) continue;

        if (
          activeLayer !== "Both" &&
          part.mounting_side !== activeLayer
        ) {
          continue;
        }

        const screen = screenPoint(pin.x, pin.y);

        const isSelectedPart =
          selectedPartId === partId;

        const isSelectedNet =
          selectedNetName &&
          pin.net === selectedNetName;

        const isSelectedPad =
          selectedPadIndex != null &&
          Number(pin.index) === Number(selectedPadIndex);

        const spacing =
          padMetricsByPart.get(partId) || 6;

        const padPixels = Math.max(
          2,
          Math.min(10, spacing * scale * 0.28),
        );

        const padSize =
          isSelectedPad || isSelectedPart || isSelectedNet
            ? Math.max(6, padPixels + 2)
            : padPixels;

        const half = padSize / 2;

        ctx.beginPath();
        ctx.roundRect(
          screen.x - half,
          screen.y - half,
          padSize,
          padSize,
          Math.min(2, half * 0.4),
        );

        if (isSelectedPad) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 1.5;
        } else if (isSelectedPart) {
          ctx.fillStyle = "#facc15";
          ctx.strokeStyle = "#fde68a";
          ctx.lineWidth = 1;
        } else if (isSelectedNet) {
          ctx.fillStyle = "#22d3ee";
          ctx.strokeStyle = "#a5f3fc";
          ctx.lineWidth = 0.8;
        } else if (part.mounting_side === "Bottom") {
          ctx.fillStyle = "#60a5fa";
          ctx.strokeStyle = "rgba(255,255,255,0.18)";
          ctx.lineWidth = 0.6;
        } else {
          ctx.fillStyle = "#f87171";
          ctx.strokeStyle = "rgba(255,255,255,0.18)";
          ctx.lineWidth = 0.6;
        }

        ctx.fill();
        ctx.stroke();
      }

      // ---------------------------------
      // NAILS
      // ---------------------------------
      for (const nail of board.nails) {
        if (
          activeLayer !== "Both" &&
          nail.side !== activeLayer
        ) {
          continue;
        }

        const screen = screenPoint(nail.x, nail.y);

        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle =
          nail.side === "Bottom" ? "#a78bfa" : "#fb923c";
        ctx.fill();
      }

      // ---------------------------------
      // SELECTED COMPONENT BOX
      // ---------------------------------
      if (selectedPart) {
        const box = partBounds.get(selectedPartId);

        if (box) {
          const corners = [
            [box.minX, box.minY],
            [box.maxX, box.minY],
            [box.maxX, box.maxY],
            [box.minX, box.maxY],
          ].map(([x, y]) => screenPoint(x, y));

          const minSX = Math.min(...corners.map((point) => point.x));
          const maxSX = Math.max(...corners.map((point) => point.x));
          const minSY = Math.min(...corners.map((point) => point.y));
          const maxSY = Math.max(...corners.map((point) => point.y));

          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(
            minSX - 8,
            minSY - 8,
            Math.max(12, maxSX - minSX + 16),
            Math.max(12, maxSY - minSY + 16),
          );
          ctx.setLineDash([]);

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 13px Arial";
          ctx.fillText(
            selectedPart.name,
            minSX,
            Math.max(16, minSY - 12),
          );
        }
      }
    };

    draw();
    window.addEventListener("resize", draw);

    return () => {
      window.removeEventListener("resize", draw);
    };
  }, [
    board,
    boardInfo,
    selectedPart,
    selectedNet,
    selectedPad,
    activeLayer,
    rotation,
    flipX,
    flipY,
    view,
    partMap,
    partBounds,
    padMetricsByPart,
  ]);

  const zoomIn = () => {
    setView((old) => ({
      ...old,
      zoom: Math.min(old.zoom * 1.25, 30),
    }));
  };

  const zoomOut = () => {
    setView((old) => ({
      ...old,
      zoom: Math.max(old.zoom / 1.25, 0.15),
    }));
  };

  const resetView = () => {
    setView({
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    });
  };

  const handleWheel = (event) => {
    event.preventDefault();

    const factor = event.deltaY < 0 ? 1.15 : 0.87;

    setView((old) => ({
      ...old,
      zoom: Math.max(
        0.15,
        Math.min(old.zoom * factor, 30),
      ),
    }));
  };

  const handleCanvasClick = (event) => {
    const canvas = canvasRef.current;

    if (!canvas || !boardInfo) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const fitScale = getFitScale(
      rect.width,
      rect.height,
      boardInfo.width,
      boardInfo.height,
      rotation,
    );

    const scale = fitScale * view.zoom;

    if (scale <= 0) return;

    const viewVector = {
      x: (mouseX - rect.width / 2 - view.offsetX) / scale,
      y: (mouseY - rect.height / 2 - view.offsetY) / scale,
    };

    const boardVector = inverseTransformVector(
      viewVector.x,
      viewVector.y,
      rotation,
      flipX,
      flipY,
    );

    const boardX = boardInfo.centerX + boardVector.x;
    const boardY = boardInfo.centerY + boardVector.y;

    let nearestPin = null;
    let nearestPinDistance = Infinity;

    for (const pin of board.pins) {
      const partId = Number(getPinPartId(pin));
      const part = partMap.get(partId);

      if (!part) continue;

      if (
        activeLayer !== "Both" &&
        part.mounting_side !== activeLayer
      ) {
        continue;
      }

      const pinView = transformVector(
        pin.x - boardInfo.centerX,
        pin.y - boardInfo.centerY,
        rotation,
        flipX,
        flipY,
      );

      const pinScreenX =
        rect.width / 2 +
        view.offsetX +
        pinView.x * scale;

      const pinScreenY =
        rect.height / 2 +
        view.offsetY +
        pinView.y * scale;

      const distance = Math.hypot(
        mouseX - pinScreenX,
        mouseY - pinScreenY,
      );

      if (distance < nearestPinDistance) {
        nearestPinDistance = distance;
        nearestPin = pin;
      }
    }

    const padHitRadius = 14;

    if (nearestPin && nearestPinDistance <= padHitRadius) {
      const partId = Number(getPinPartId(nearestPin));
      const part = partMap.get(partId);

      if (part) {
        onSelectPad(nearestPin);
        onSelectPart(part);
        return;
      }
    }

    let nearestPart = null;
    let nearestDistance = Infinity;

    for (const [partId, box] of partBounds) {
      const part = partMap.get(partId);
      if (!part) continue;

      if (
        activeLayer !== "Both" &&
        part.mounting_side !== activeLayer
      ) {
        continue;
      }

      const basePadding = 180 / Math.max(view.zoom, 1);

      const inside =
        boardX >= box.minX - basePadding &&
        boardX <= box.maxX + basePadding &&
        boardY >= box.minY - basePadding &&
        boardY <= box.maxY + basePadding;

      if (!inside) continue;

      const centerPartX = (box.minX + box.maxX) / 2;
      const centerPartY = (box.minY + box.maxY) / 2;

      const distance = Math.hypot(
        boardX - centerPartX,
        boardY - centerPartY,
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPart = part;
      }
    }

    if (nearestPart) {
      onSelectPad(null);
      onSelectPart(nearestPart);
    }
  };

  const handleMouseDown = (event) => {
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
    };
  };

  const handleMouseMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;

    setView((old) => ({
      ...old,
      offsetX:
        drag.offsetX + (event.clientX - drag.clientX),
      offsetY:
        drag.offsetY + (event.clientY - drag.clientY),
    }));
  };

  const stopDragging = () => {
    dragRef.current = null;
  };

  return (
    <div className="viewer-wrapper">
      <canvas
        ref={canvasRef}
        className="pcb-canvas"
        onWheel={handleWheel}
        onClick={handleCanvasClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
      />

      <div className="viewer-toolbar">
        <button onClick={zoomIn} title="Zoom in">
          +
        </button>
        <button onClick={zoomOut} title="Zoom out">
          −
        </button>
        <button onClick={resetView} title="Fit / reset view">
          Fit
        </button>
        <div className="toolbar-separator" />
        <button onClick={() => onRotate(-90)} title="Rotate left">
          ↺
        </button>
        <button onClick={() => onRotate(90)} title="Rotate right">
          ↻
        </button>
        <button onClick={onFlipX} title="Mirror horizontally">
          ⇆
        </button>
        <button onClick={onFlipY} title="Mirror vertically">
          ⇅
        </button>
      </div>
    </div>
  );
}

function ComponentInspector({
  board,
  selectedPart,
  partPins,
  selectedPad,
}) {
  if (!selectedPart) {
    return (
      <div className="empty-inspector">
        <div className="empty-title">Nothing selected</div>
        <div className="empty-description">
          Search or select a component to inspect its details.
        </div>
      </div>
    );
  }

  const pinIndices = Array.isArray(selectedPart.pin_indices)
    ? selectedPart.pin_indices
    : null;

  const pins = pinIndices
    ? pinIndices.map((index) => board.pins[index]).filter(Boolean)
    : partPins.get(Number(selectedPart.id)) || [];

  const uniqueNets = [
    ...new Set(
      pins
        .map((pin) => pin.net?.trim())
        .filter(Boolean),
    ),
  ];

  return (
    <div className="inspector">
      <div className="inspector-header">
        <div>
          <div className="inspector-ref">
            {selectedPart.name}
          </div>
          <div className="inspector-subtitle">
            {selectedPart.mounting_side} · {selectedPart.part_type}
          </div>
        </div>
      </div>

      <div className="inspector-grid">
        <div className="info-card">
          <span>Part Type</span>
          <strong>{selectedPart.part_type}</strong>
        </div>
        <div className="info-card">
          <span>Side</span>
          <strong>{selectedPart.mounting_side}</strong>
        </div>
        <div className="info-card">
          <span>Pins</span>
          <strong>{pins.length}</strong>
        </div>
        <div className="info-card">
          <span>Nets</span>
          <strong>{uniqueNets.length}</strong>
        </div>
      </div>

      {selectedPad ? (
        <div className="inspector-block">
          <div className="block-title">Selected Pad</div>
          <div className="info-card">
            <span>Pad / Pin</span>
            <strong>
              {pins.findIndex(
                (pin) =>
                  Number(pin.index) === Number(selectedPad.index),
              ) + 1}
            </strong>
            <span className="detail-label">Net</span>
            <strong>{selectedPad.net?.trim() || "No Net"}</strong>
            <span className="detail-label">Coordinates</span>
            <strong>
              X {selectedPad.x} · Y {selectedPad.y}
            </strong>
          </div>
        </div>
      ) : null}

      <div className="inspector-block">
        <div className="block-title">Connected Nets</div>
        <div className="net-tags">
          {uniqueNets.length === 0 ? (
            <div className="muted">No net information</div>
          ) : (
            uniqueNets.map((net) => (
              <span className="net-tag" key={net}>
                {net}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="inspector-block">
        <div className="block-title">Pin / Net Connections</div>
        <div className="pin-table">
          <div className="pin-row pin-header">
            <span>#</span>
            <span>Net</span>
          </div>

          {pins.map((pin, index) => (
            <div
              className="pin-row"
              key={`${selectedPart.id}-${index}`}
            >
              <span>{index + 1}</span>
              <span className="pin-net">
                {pin.net?.trim() || "No Net"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NetInspector({ board, selectedNet }) {
  if (!selectedNet) return null;

  const indexed = board.net_index?.[selectedNet.net];

  const connections = indexed
    ? indexed.pin_indices
        .map((index) => board.pins[index])
        .filter(Boolean)
    : board.pins.filter(
        (pin) => pin.net?.trim() === selectedNet.net,
      );

  const componentIds = indexed
    ? indexed.part_ids
    : [
        ...new Set(
          connections.map((pin) => Number(getPinPartId(pin))),
        ),
      ];

  return (
    <div className="net-inspector">
      <div className="block-title">Selected Net</div>
      <div className="selected-net-name">
        {selectedNet.net}
      </div>
      <div className="net-stats">
        <div>
          <span>Pins</span>
          <strong>{connections.length}</strong>
        </div>
        <div>
          <span>Components</span>
          <strong>{componentIds.length}</strong>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");

  const [componentSearch, setComponentSearch] = useState("");
  const [netSearch, setNetSearch] = useState("");

  const [selectedPart, setSelectedPart] = useState(null);
  const [selectedNet, setSelectedNet] = useState(null);
  const [selectedPad, setSelectedPad] = useState(null);

  const [activeLayer, setActiveLayer] = useState("Top");
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);

  const partPins = useMemo(() => {
    if (!board) return new Map();

    const map = new Map();

    for (const pin of board.pins) {
      const rawPartId = getPinPartId(pin);
      if (rawPartId == null) continue;

      const partId = Number(rawPartId);
      if (!Number.isFinite(partId)) continue;

      if (!map.has(partId)) {
        map.set(partId, []);
      }

      map.get(partId).push(pin);
    }

    return map;
  }, [board]);

  useEffect(() => {
    fetch("/board.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Unable to load board.json");
        }
        return response.json();
      })
      .then((data) => setBoard(data))
      .catch((err) => {
        console.error(err);
        setError(err.message);
      });
  }, []);

  const filteredComponents = useMemo(() => {
    if (!board) return [];

    const search = componentSearch.trim().toLowerCase();

    return board.parts
      .filter((part) => {
        const matchesSearch = part.name
          .toLowerCase()
          .includes(search);

        const matchesLayer =
          activeLayer === "Both" ||
          part.mounting_side === activeLayer;

        return matchesSearch && matchesLayer;
      })
      .slice(0, 100);
  }, [board, componentSearch, activeLayer]);

  const filteredNets = useMemo(() => {
    if (!board) return [];

    const search = netSearch.trim().toLowerCase();

    if (!search) {
      return board.nets.slice(0, 100);
    }

    return board.nets
      .filter((net) => net.toLowerCase().includes(search))
      .slice(0, 100);
  }, [board, netSearch]);

  const changeLayer = (layer) => {
    setActiveLayer(layer);
    setSelectedNet(null);
    setSelectedPad(null);

    if (
      selectedPart &&
      layer !== "Both" &&
      selectedPart.mounting_side !== layer
    ) {
      setSelectedPart(null);
    }
  };

  const rotateBoard = (amount) => {
    setSelectedPad(null);
    setRotation((current) => normalizeAngle(current + amount));
  };

  const flipHorizontal = () => {
    setSelectedPad(null);
    setFlipX((value) => !value);
  };

  const flipVertical = () => {
    setSelectedPad(null);
    setFlipY((value) => !value);
  };

  if (error) {
    return (
      <div className="loading-screen">
        <h2>PCB Viewer Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!board) {
    return (
      <div className="loading-screen">Loading PCB...</div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">PCB BoardViewer</div>
        <div className="file-name">
          {board.source_file}
        </div>
      </header>

      <div className="workspace">
        <main className="viewer-area">
          <PCBCanvas
            board={board}
            selectedPart={selectedPart}
            selectedNet={selectedNet}
            selectedPad={selectedPad}
            activeLayer={activeLayer}
            rotation={rotation}
            flipX={flipX}
            flipY={flipY}
            onRotate={rotateBoard}
            onFlipX={flipHorizontal}
            onFlipY={flipVertical}
            onSelectPart={(part) => {
              setSelectedPart(part);
              setSelectedNet(null);
            }}
            onSelectPad={setSelectedPad}
          />

          <div className="layer-toolbar">
            <button
              className={
                activeLayer === "Top"
                  ? "layer-button active"
                  : "layer-button"
              }
              onClick={() => changeLayer("Top")}
            >
              Top
            </button>

            <button
              className={
                activeLayer === "Bottom"
                  ? "layer-button active"
                  : "layer-button"
              }
              onClick={() => changeLayer("Bottom")}
            >
              Bottom
            </button>

            <button
              className={
                activeLayer === "Both"
                  ? "layer-button active"
                  : "layer-button"
              }
              onClick={() => changeLayer("Both")}
            >
              Both
            </button>
          </div>

          <div className="view-state">
            <span>Rotation {normalizeAngle(rotation)}°</span>
            {flipX ? <span>Mirror X</span> : null}
            {flipY ? <span>Mirror Y</span> : null}
          </div>

          <div className="stats">
            <span>Parts {board.counts_parsed.parts}</span>
            <span>Pins {board.counts_parsed.pins}</span>
            <span>
              Nets {board.counts_parsed.unique_pin_nets}
            </span>
          </div>
        </main>

        <aside className="side-panel">
          <section className="panel-section components-section">
            <div className="section-heading">
              <h2>Components</h2>
              <span>{board.parts.length}</span>
            </div>

            <input
              value={componentSearch}
              onChange={(event) =>
                setComponentSearch(event.target.value)
              }
              placeholder="Search component..."
            />

            <div className="results">
              {filteredComponents.map((part) => (
                <button
                  key={part.id}
                  className={
                    selectedPart?.id === part.id
                      ? "result selected"
                      : "result"
                  }
                  onClick={() => {
                    setSelectedPart(part);
                    setSelectedNet(null);
                    setSelectedPad(null);
                  }}
                >
                  <strong>{part.name}</strong>
                  <small>
                    {part.mounting_side} · {part.part_type}
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section nets-section">
            <div className="section-heading">
              <h2>Nets</h2>
              <span>{board.nets.length}</span>
            </div>

            <input
              value={netSearch}
              onChange={(event) =>
                setNetSearch(event.target.value)
              }
              placeholder="Search net..."
            />

            <div className="results">
              {filteredNets.map((net) => (
                <button
                  key={net}
                  className={
                    selectedNet?.net === net
                      ? "result selected"
                      : "result"
                  }
                  onClick={() => {
                    setSelectedNet({ net });
                    setSelectedPart(null);
                    setSelectedPad(null);
                  }}
                >
                  {net}
                </button>
              ))}
            </div>
          </section>

          <section className="inspector-section">
            <ComponentInspector
              board={board}
              selectedPart={selectedPart}
              partPins={partPins}
              selectedPad={selectedPad}
            />

            <NetInspector
              board={board}
              selectedNet={selectedNet}
            />
          </section>
        </aside>
      </div>
    </div>
  );
}

export default App;
