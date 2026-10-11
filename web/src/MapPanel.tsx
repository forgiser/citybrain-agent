import { useEffect, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { api } from "./api";
import { getWebClientId } from "./clientId";
import type { Artifact } from "./types";

setWorkerUrl(mapLibreWorkerUrl);

interface MapPanelProps {
  sessionId?: string;
  artifacts: Artifact[];
  autoFit: boolean;
  baseMap: "osm" | "blank";
  onLayerAdded: (artifact: Artifact) => void;
  onLayerRemoved: (artifactId: string) => void;
}

interface MapSelection {
  layerId: string;
  featureId?: string | number;
  geometryType?: string;
  properties?: Record<string, unknown>;
}

interface MapCommandEnvelope {
  id: string;
  command: "set_view" | "fit_layer" | "add_layer" | "remove_layer" | "set_layer_visibility";
  payload: Record<string, unknown>;
}

interface MapCommandHandlers {
  onLayerAdded: (artifact: Artifact) => void;
  onLayerRemoved: (artifactId: string) => void;
  setLayerVisibility: (artifactId: string, visible: boolean) => void;
}

export function MapPanel({ sessionId, artifacts, autoFit, baseMap, onLayerAdded, onLayerRemoved }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [layerErrors, setLayerErrors] = useState<Map<string, string>>(new Map());
  const [mapError, setMapError] = useState<string>();
  const artifactsRef = useRef(artifacts);
  const hiddenLayersRef = useRef(hiddenLayers);
  const selectionRef = useRef<MapSelection | undefined>(undefined);
  const clientIdRef = useRef(getWebClientId());

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const savedView = readSavedView(sessionId);
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        center: savedView?.center ?? [105, 35],
        zoom: savedView?.zoom ?? 3,
        style: {
          version: 8,
          sources: baseMap === "osm" ? {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          } : {},
          layers: baseMap === "osm" ? [{ id: "osm", type: "raster", source: "osm" }] : [],
        },
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    setMapError(undefined);
    map.addControl(new NavigationControl(), "top-right");
    map.addControl(new ScaleControl(), "bottom-left");
    const reportState = (): void => {
      if (!sessionId) return;
      void reportMapState(
        map,
        sessionId,
        clientIdRef.current,
        artifactsRef.current,
        hiddenLayersRef.current,
        selectionRef.current,
      );
    };
    map.on("error", (event) => {
      const message = event.error instanceof Error
        ? event.error.message
        : String(event.error);
      if (/worker|webgl|gpu/iu.test(message)) setMapError(message);
    });
    map.on("moveend", () => {
      if (!sessionId) return;
      const center = map.getCenter();
      localStorage.setItem(
        `geoagent-map-view:${sessionId}`,
        JSON.stringify({ center: [center.lng, center.lat], zoom: map.getZoom() }),
      );
      reportState();
    });
    map.on("load", reportState);
    map.on("click", (event) => {
      const features = map.queryRenderedFeatures(event.point).filter((feature) =>
        feature.layer.id.startsWith("fill-") ||
        feature.layer.id.startsWith("line-") ||
        feature.layer.id.startsWith("point-"),
      );
      const feature = features[0];
      if (!feature) {
        selectionRef.current = undefined;
        reportState();
        return;
      }
      selectionRef.current = {
        layerId: feature.layer.id,
        ...(feature.id !== undefined ? { featureId: feature.id } : {}),
        ...(feature.geometry?.type ? { geometryType: feature.geometry.type } : {}),
        ...(feature.properties ? { properties: feature.properties } : {}),
      };
      const content = document.createElement("div");
      content.className = "feature-popup";
      const title = document.createElement("strong");
      title.textContent = "要素属性";
      const properties = document.createElement("pre");
      properties.textContent = JSON.stringify(feature.properties ?? {}, null, 2);
      content.append(title, properties);
      new Popup({ maxWidth: "360px" })
        .setLngLat(event.lngLat)
        .setDOMContent(content)
        .addTo(map);
      reportState();
    });
    const heartbeat = window.setInterval(reportState, 15_000);
    mapRef.current = map;
    return () => {
      window.clearInterval(heartbeat);
      if (sessionId) {
        void api(`/api/sessions/${sessionId}/map-state`, {
          method: "DELETE",
          body: JSON.stringify({ clientId: clientIdRef.current }),
        }).catch(() => undefined);
      }
      map.remove();
      mapRef.current = null;
    };
  }, [baseMap, sessionId]);

  useEffect(() => {
    artifactsRef.current = artifacts;
    hiddenLayersRef.current = hiddenLayers;
    const map = mapRef.current;
    if (map && sessionId) {
      void reportMapState(
        map,
        sessionId,
        clientIdRef.current,
        artifacts,
        hiddenLayers,
        selectionRef.current,
      );
    }
  }, [artifacts, hiddenLayers, sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const clientId = clientIdRef.current;
    const source = new EventSource(
      `/api/sessions/${sessionId}/map-commands?clientId=${encodeURIComponent(clientId)}`,
    );
    const handleCommand = (rawEvent: Event): void => {
      const event = rawEvent as MessageEvent<string>;
      void (async () => {
        let command: MapCommandEnvelope | undefined;
        try {
          command = JSON.parse(event.data) as MapCommandEnvelope;
          const map = mapRef.current;
          if (!map) throw new Error("The Web map is not initialized.");
          const result = await executeMapCommand(
            map,
            command,
            artifactsRef.current,
            sessionId,
            clientId,
            hiddenLayersRef.current,
            selectionRef.current,
            {
              onLayerAdded,
              onLayerRemoved,
              setLayerVisibility: (artifactId, visible) => {
                setHiddenLayers((value) => {
                  const next = new Set(value);
                  if (visible) next.delete(artifactId); else next.add(artifactId);
                  hiddenLayersRef.current = next;
                  return next;
                });
              },
            },
          );
          await api(`/api/sessions/${sessionId}/map-command-results`, {
            method: "POST",
            body: JSON.stringify({ clientId, id: command.id, ok: true, result }),
          });
        } catch (error) {
          if (!command?.id) return;
          await api(`/api/sessions/${sessionId}/map-command-results`, {
            method: "POST",
            body: JSON.stringify({
              clientId,
              id: command.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }).catch(() => undefined);
        }
      })();
    };
    source.addEventListener("command", handleCommand);
    return () => {
      source.removeEventListener("command", handleCommand);
      source.close();
    };
  }, [onLayerAdded, onLayerRemoved, sessionId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    let cancelled = false;
    const load = (): void => {
      if (cancelled) return;
      const activeIds = new Set(artifacts.map((artifact) => artifact.id));
      for (const layer of map.getStyle().layers ?? []) {
        const artifactId = layer.id.match(/^(?:fill|line|point)-(.+)$/u)?.[1];
        if (artifactId && !activeIds.has(artifactId) && map.getLayer(layer.id)) map.removeLayer(layer.id);
      }
      for (const sourceId of Object.keys(map.getStyle().sources ?? {})) {
        const artifactId = sourceId.startsWith("source-") ? sourceId.slice("source-".length) : undefined;
        if (artifactId && !activeIds.has(artifactId) && map.getSource(sourceId)) map.removeSource(sourceId);
      }
      for (const artifact of artifacts) {
        if (artifact.status !== "ready" || artifact.map?.format !== "geojson" || !artifact.map.dataUrl) continue;
        const sourceId = `source-${artifact.id}`;
        if (map.getSource(sourceId)) continue;
        void fetch(artifact.map.dataUrl)
          .then(async (response) => {
            if (!response.ok) throw new Error(`读取图层失败（HTTP ${response.status}）`);
            const value = await response.json() as unknown;
            if (!isGeoJson(value)) throw new Error("文件不是有效的 GeoJSON 数据");
            return value;
          })
          .then((geojson: GeoJSON.GeoJSON) => {
            if (cancelled || mapRef.current !== map) return;
            setLayerErrors((value) => {
              const next = new Map(value);
              next.delete(artifact.id);
              return next;
            });
            if (map.getSource(sourceId)) {
              (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
              return;
            }
            map.addSource(sourceId, { type: "geojson", data: geojson });
            map.addLayer({
              id: `fill-${artifact.id}`,
              type: "fill",
              source: sourceId,
              filter: ["==", ["geometry-type"], "Polygon"],
              paint: { "fill-color": "#22c55e", "fill-opacity": (artifact.layer?.opacity ?? 1) * 0.28, "fill-outline-color": "#86efac" },
            });
            map.addLayer({
              id: `line-${artifact.id}`,
              type: "line",
              source: sourceId,
              filter: ["==", ["geometry-type"], "LineString"],
              paint: { "line-color": "#38bdf8", "line-width": 3, "line-opacity": artifact.layer?.opacity ?? 1 },
            });
            map.addLayer({
              id: `point-${artifact.id}`,
              type: "circle",
              source: sourceId,
              filter: ["==", ["geometry-type"], "Point"],
              paint: { "circle-color": "#f59e0b", "circle-radius": 6, "circle-opacity": artifact.layer?.opacity ?? 1, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
            });
            if (autoFit) fitGeoJson(map, geojson);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setLayerErrors((value) => new Map(value).set(
              artifact.id,
              error instanceof Error ? error.message : String(error),
            ));
          });
      }
    };
    if (map.loaded()) load();
    else map.once("load", load);
    return () => {
      cancelled = true;
      map.off("load", load);
    };
  }, [artifacts, autoFit, sessionId]);

  function toggleLayer(artifactId: string) {
    const map = mapRef.current;
    const hidden = hiddenLayers.has(artifactId);
    for (const prefix of ["fill", "line", "point"]) {
      const id = `${prefix}-${artifactId}`;
      if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", hidden ? "visible" : "none");
    }
    setHiddenLayers((value) => {
      const next = new Set(value);
      if (hidden) next.delete(artifactId); else next.add(artifactId);
      hiddenLayersRef.current = next;
      if (map && sessionId) {
        void reportMapState(
          map,
          sessionId,
          clientIdRef.current,
          artifactsRef.current,
          next,
          selectionRef.current,
        );
      }
      return next;
    });
    if (sessionId) {
      void api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ visible: hidden }),
      }).catch(() => undefined);
    }
  }

  function setLayerOpacity(artifactId: string, opacity: number) {
    const map = mapRef.current;
    if (map?.getLayer(`fill-${artifactId}`)) map.setPaintProperty(`fill-${artifactId}`, "fill-opacity", opacity * 0.28);
    if (map?.getLayer(`line-${artifactId}`)) map.setPaintProperty(`line-${artifactId}`, "line-opacity", opacity);
    if (map?.getLayer(`point-${artifactId}`)) map.setPaintProperty(`point-${artifactId}`, "circle-opacity", opacity);
    if (sessionId) {
      void api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ opacity }),
      }).catch(() => undefined);
    }
  }

  async function removeLayer(artifactId: string) {
    const map = mapRef.current;
    if (map) removeMapLayer(map, artifactId);
    onLayerRemoved(artifactId);
    if (sessionId) {
      await api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, { method: "DELETE" });
    }
  }

  async function zoomTo(artifact: Artifact) {
    const map = mapRef.current;
    if (!map || !artifact.map?.dataUrl) return;
    const geojson = await fetch(artifact.map.dataUrl).then((response) => response.json()) as GeoJSON.GeoJSON;
    fitGeoJson(map, geojson);
  }

  return (
    <main className="map-panel">
      <div ref={containerRef} className="map-canvas" />
      {mapError && (
        <div className="map-error">
          <strong>地图暂时无法初始化</strong>
          <span>{mapError}</span>
          <small>Agent 问答和项目文件仍可继续使用。</small>
        </div>
      )}
      <div className="map-title">
        <span className="status-dot" />
        空间工作区
      </div>
      <div className="layer-card">
        <strong>图层</strong>
        {artifacts.filter((item) => item.map?.format === "geojson").length === 0 ? (
          <p>地图不会自动加载文件。请在项目目录中点击“＋图”添加 GeoJSON、SHP、GPKG、KML 或 GML。</p>
        ) : artifacts.filter((item) => item.map?.format === "geojson").map((item) => (
          <div className="layer-entry" key={item.id}>
            <div className="layer-row">
              <input type="checkbox" checked={!hiddenLayers.has(item.id)} onChange={() => toggleLayer(item.id)} />
              <span className="layer-swatch" />
              <span>{item.name}</span>
              <button title="缩放至图层" onClick={() => void zoomTo(item)}>⌖</button>
              <button title="移除图层" onClick={() => void removeLayer(item.id)}>×</button>
            </div>
            <input
              className="layer-opacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              defaultValue={item.layer?.opacity ?? 1}
              title="图层透明度"
              onChange={(event) => setLayerOpacity(item.id, Number(event.target.value))}
            />
            {layerErrors.get(item.id) && <small className="layer-error">{layerErrors.get(item.id)}</small>}
          </div>
        ))}
      </div>
    </main>
  );
}

async function reportMapState(
  map: MapLibreMap,
  sessionId: string,
  clientId: string,
  artifacts: Artifact[],
  hiddenLayers: Set<string>,
  selection: MapSelection | undefined,
): Promise<void> {
  const center = map.getCenter();
  const bounds = map.getBounds();
  await api(`/api/sessions/${sessionId}/map-state`, {
    method: "PUT",
    body: JSON.stringify({
      clientId,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      layers: artifacts
        .filter((artifact) => artifact.map)
        .map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          visible: !hiddenLayers.has(artifact.id),
          format: artifact.map?.format,
        })),
      ...(selection ? { selection } : {}),
    }),
  }).catch(() => undefined);
}

async function executeMapCommand(
  map: MapLibreMap,
  envelope: MapCommandEnvelope,
  artifacts: Artifact[],
  sessionId: string,
  clientId: string,
  hiddenLayers: Set<string>,
  selection: MapSelection | undefined,
  handlers: MapCommandHandlers,
): Promise<Record<string, unknown>> {
  await waitForMapLoad(map);
  const durationMs = readCommandNumber(envelope.payload.durationMs, 0);
  let reportedArtifacts = artifacts;
  let reportedHiddenLayers = hiddenLayers;
  if (envelope.command === "set_view") {
    const center = readCommandCoordinate(envelope.payload.center);
    await runMapMovement(map, durationMs, () => {
      map.easeTo({
        center,
        ...(typeof envelope.payload.zoom === "number" ? { zoom: envelope.payload.zoom } : {}),
        ...(typeof envelope.payload.bearing === "number" ? { bearing: envelope.payload.bearing } : {}),
        ...(typeof envelope.payload.pitch === "number" ? { pitch: envelope.payload.pitch } : {}),
        duration: durationMs,
      });
    });
  } else if (envelope.command === "fit_layer") {
    const layer = String(envelope.payload.layer ?? "").trim();
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact?.map?.dataUrl) throw new Error(`Map layer not found or not ready: ${layer}`);
    const geojson = await fetch(artifact.map.dataUrl).then(async (response) => {
      if (!response.ok) throw new Error(`Unable to load layer data: ${response.status}`);
      return response.json() as Promise<GeoJSON.GeoJSON>;
    });
    await runMapMovement(map, durationMs, () => {
      fitGeoJson(map, geojson, {
        padding: readCommandNumber(envelope.payload.padding, 70),
        maxZoom: readCommandNumber(envelope.payload.maxZoom, 14),
        duration: durationMs,
      });
    });
  } else if (envelope.command === "add_layer") {
    const path = readCommandString(envelope.payload.path, "path");
    const artifact = await api<Artifact>(`/api/sessions/${sessionId}/map/layers`, {
      method: "POST",
      body: JSON.stringify({ absolutePath: path }),
    });
    if (artifact.status !== "ready" || artifact.map?.format !== "geojson" || !artifact.map.dataUrl) {
      throw new Error(`The vector file could not be prepared as a display-ready GeoJSON layer: ${path}`);
    }
    await addGeoJsonLayer(map, artifact, envelope.payload.fit !== false);
    handlers.onLayerAdded(artifact);
    reportedArtifacts = [artifact, ...artifacts.filter((item) => item.id !== artifact.id)];
  } else if (envelope.command === "remove_layer") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    removeMapLayer(map, artifact.id);
    handlers.onLayerRemoved(artifact.id);
    await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, { method: "DELETE" });
    reportedArtifacts = artifacts.filter((item) => item.id !== artifact.id);
  } else if (envelope.command === "set_layer_visibility") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const visible = readCommandBoolean(envelope.payload.visible, "visible");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    setMapLayerVisibility(map, artifact.id, visible);
    handlers.setLayerVisibility(artifact.id, visible);
    await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, {
      method: "PATCH",
      body: JSON.stringify({ visible }),
    });
    reportedHiddenLayers = new Set(hiddenLayers);
    if (visible) reportedHiddenLayers.delete(artifact.id);
    else reportedHiddenLayers.add(artifact.id);
  } else {
    throw new Error(`Unsupported map command: ${String(envelope.command)}`);
  }

  await reportMapState(map, sessionId, clientId, reportedArtifacts, reportedHiddenLayers, selection);
  return {
    ...currentMapView(map),
    layers: reportedArtifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      visible: !reportedHiddenLayers.has(artifact.id),
      format: artifact.map?.format,
    })),
  };
}

async function addGeoJsonLayer(map: MapLibreMap, artifact: Artifact, fit: boolean): Promise<void> {
  if (!artifact.map?.dataUrl) throw new Error(`Layer data is unavailable: ${artifact.name}`);
  const response = await fetch(artifact.map.dataUrl);
  if (!response.ok) throw new Error(`Unable to load layer data: ${response.status}`);
  const value = await response.json() as unknown;
  if (!isGeoJson(value)) throw new Error(`File is not valid GeoJSON: ${artifact.name}`);
  const sourceId = `source-${artifact.id}`;
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(value);
  } else {
    map.addSource(sourceId, { type: "geojson", data: value });
    map.addLayer({
      id: `fill-${artifact.id}`,
      type: "fill",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#22c55e", "fill-opacity": (artifact.layer?.opacity ?? 1) * 0.28, "fill-outline-color": "#86efac" },
    });
    map.addLayer({
      id: `line-${artifact.id}`,
      type: "line",
      source: sourceId,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#38bdf8", "line-width": 3, "line-opacity": artifact.layer?.opacity ?? 1 },
    });
    map.addLayer({
      id: `point-${artifact.id}`,
      type: "circle",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": "#f59e0b", "circle-radius": 6, "circle-opacity": artifact.layer?.opacity ?? 1, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
    });
  }
  if (fit) fitGeoJson(map, value);
}

function removeMapLayer(map: MapLibreMap, artifactId: string): void {
  for (const prefix of ["fill", "line", "point"]) {
    const id = `${prefix}-${artifactId}`;
    if (map.getLayer(id)) map.removeLayer(id);
  }
  const sourceId = `source-${artifactId}`;
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

function setMapLayerVisibility(map: MapLibreMap, artifactId: string, visible: boolean): void {
  for (const prefix of ["fill", "line", "point"]) {
    const id = `${prefix}-${artifactId}`;
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function waitForMapLoad(map: MapLibreMap): Promise<void> {
  if (map.loaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      map.off("load", onLoad);
      reject(new Error("The Web map did not finish loading in time."));
    }, 10_000);
    const onLoad = (): void => {
      window.clearTimeout(timeout);
      resolve();
    };
    map.once("load", onLoad);
  });
}

function runMapMovement(
  map: MapLibreMap,
  durationMs: number,
  start: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      map.off("moveend", finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, Math.max(durationMs + 2_000, 2_000));
    map.once("moveend", finish);
    try {
      start();
      if (durationMs === 0) window.setTimeout(finish, 0);
    } catch (error) {
      settled = true;
      window.clearTimeout(timeout);
      map.off("moveend", finish);
      reject(error);
    }
  });
}

function currentMapView(map: MapLibreMap): Record<string, unknown> {
  const center = map.getCenter();
  const bounds = map.getBounds();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
  };
}

function readCommandCoordinate(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    throw new Error("Invalid map center received from the server.");
  }
  return [value[0], value[1]];
}

function readCommandNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readCommandString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function readCommandBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function fitGeoJson(
  map: MapLibreMap,
  geojson: GeoJSON.GeoJSON,
  options: { padding?: number; maxZoom?: number; duration?: number } = {},
): void {
  const coordinates: number[][] = [];
  collectCoordinates(geojson, coordinates);
  if (coordinates.length === 0) throw new Error("GeoJSON contains no coordinates to fit.");
  const bounds = coordinates.reduce(
    (current, coordinate) => current.extend(coordinate as [number, number]),
    new LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number]),
  );
  map.fitBounds(bounds, {
    padding: options.padding ?? 70,
    maxZoom: options.maxZoom ?? 14,
    duration: options.duration ?? 800,
  });
}

function collectCoordinates(value: unknown, output: number[][]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      output.push(value as number[]);
      return;
    }
    for (const item of value) collectCoordinates(item, output);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.coordinates) collectCoordinates(record.coordinates, output);
    if (record.geometry) collectCoordinates(record.geometry, output);
    if (record.features) collectCoordinates(record.features, output);
    if (record.geometries) collectCoordinates(record.geometries, output);
  }
}

function isGeoJson(value: unknown): value is GeoJSON.GeoJSON {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && [
    "FeatureCollection", "Feature", "GeometryCollection", "Point", "MultiPoint",
    "LineString", "MultiLineString", "Polygon", "MultiPolygon",
  ].includes(type);
}

function readSavedView(sessionId: string | undefined): {
  center: [number, number];
  zoom: number;
} | undefined {
  if (!sessionId) return undefined;
  try {
    const value = JSON.parse(localStorage.getItem(`geoagent-map-view:${sessionId}`) ?? "null") as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { center?: unknown }).center) &&
      (value as { center: unknown[] }).center.length === 2 &&
      (value as { center: unknown[] }).center.every((item) => typeof item === "number") &&
      typeof (value as { zoom?: unknown }).zoom === "number"
    ) {
      return value as { center: [number, number]; zoom: number };
    }
  } catch {
    // Ignore a malformed browser preference and use the default extent.
  }
  return undefined;
}
