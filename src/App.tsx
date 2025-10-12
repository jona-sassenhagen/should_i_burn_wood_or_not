import React, { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import Papa from "papaparse";

const BASELINE_GRID_INTENSITY: Record<string, number> = {
  DEU: 320,
  FRA: 60,
  POL: 680,
  USA: 360,
};

const DEFAULT_BASELINE_INTENSITY = 350;

const VALID_UNITS = new Set(["gco2/kwh", "gco2/kwh_e", "gco2eq/kwh"]);

const HEAT_SOURCES = [
  { id: "ASHP", label: "Air-source heat pump" },
  { id: "GSHP", label: "Ground-source heat pump" },
  { id: "DH", label: "District heating (electric)" },
  { id: "RESISTIVE", label: "Electric resistance heating" },
  { id: "GAS", label: "Gas heating" },
  { id: "OIL", label: "Oil heating" },
] as const;

type HeatSourceId = (typeof HEAT_SOURCES)[number]["id"];

type ParsedRow = Record<string, unknown>;

type PapaParseResult<T> = {
  data: T[];
  errors: Array<{ message?: string }>;
};

type IntensityRow = ParsedRow & {
  Area: string;
  Date: string;
  Variable: string;
  Unit: string;
  Value: number;
  "ISO 3 code": string;
};

type IntensityEntry = {
  date: string;
  value: number;
};

type IntensityHistory = Record<string, IntensityEntry[]>;
type MixCategory =
  | "Nuclear"
  | "Coal"
  | "Gas"
  | "Bioenergy"
  | "Hydro"
  | "Wind"
  | "Solar"
  | "Other Fossil"
  | "Other Renewables"
  | "Other";
type EnergyMixHistory = Record<string, Partial<Record<MixCategory, number>>>;
type MixIntensityHistory = Record<string, Partial<Record<MixCategory, number>>>;

type CountryOption = {
  iso3: string;
  name: string;
};

type Coordinate = {
  lat: number;
  lon: number;
};

type MixSlice = {
  category: MixCategory;
  label: string;
  value: number;
  color: string;
  emission: number;
};

const MIX_LABELS: Record<MixCategory, string> = {
  Nuclear: "Nuclear",
  Coal: "Coal",
  Gas: "Gas",
  Bioenergy: "Bioenergy",
  Hydro: "Hydro",
  Wind: "Wind",
  Solar: "Solar",
  "Other Fossil": "Other fossil",
  "Other Renewables": "Other renewables",
  Other: "Other",
};

const MIX_COLORS: Record<MixCategory, string> = {
  Nuclear: "#6366f1",
  Coal: "#1f2937",
  Gas: "#f97316",
  Bioenergy: "#22c55e",
  Hydro: "#0ea5e9",
  Wind: "#38bdf8",
  Solar: "#facc15",
  "Other Fossil": "#ef4444",
  "Other Renewables": "#a855f7",
  Other: "#94a3b8",
};

const DEFAULTS = {
  wood: {
    efCO2_fuel_g_per_kWh: 403,
    efCH4N2O_g_per_kWh: 30,
    stoveEff: 0.75,
  },
  gas: { efCO2_fuel_g_per_kWh: 202, boilerEff: 0.92 },
  oil: { efCO2_fuel_g_per_kWh: 267, boilerEff: 0.9 },
  district: { cop: 2.5 },
  gshp: { baseCOP: 4 },
  ashp: { a: 2.8, b: 0.06, min: 1.8, max: 5 },
  kyoto: { targetYear: 2050, targetGridIntensity_g_per_kWh: 50 },
} as const;

const BASE_GWPBIO: Record<number, number> = { 1: 0.95, 10: 0.85, 30: 0.7, 100: 0.5, 1000: 0.25 };
const HORIZONS = [1, 10, 30, 100, 1000];

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function ashpCOP(tC: number) {
  const { a, b, min, max } = DEFAULTS.ashp;
  return clamp(a + b * tC, min, max);
}

function gshpCOP() {
  return DEFAULTS.gshp.baseCOP;
}

function gridIntensityPath(
  currentYear: number,
  horizonYears: number,
  currentIntensity: number,
  targetYear: number,
  targetIntensity: number
) {
  const arr: number[] = [];
  for (let i = 0; i < horizonYears; i += 1) {
    const year = currentYear + i;
    if (year >= targetYear) {
      arr.push(targetIntensity);
    } else {
      const frac = (targetYear - year) / (targetYear - currentYear);
      arr.push(targetIntensity + (currentIntensity - targetIntensity) * frac);
    }
  }
  return arr;
}

function formatNumber(x: number, digits = 0) {
  return x.toLocaleString(undefined, { maximumFractionDigits: digits });
}

type IntensitySummary = {
  comparator: number;
  label: string;
};

function WoodVsHeatApp() {
  const [country, setCountry] = useState<string>("");
  const [availableCountries, setAvailableCountries] = useState<CountryOption[]>([]);
  const [countryNames, setCountryNames] = useState<Record<string, string>>({});
  const [intensityHistory, setIntensityHistory] = useState<IntensityHistory>({});
  const [energyMix, setEnergyMix] = useState<EnergyMixHistory>({});
  const [mixIntensity, setMixIntensity] = useState<MixIntensityHistory>({});
  const [intensityError, setIntensityError] = useState<string>("");
  const [isLoadingIntensity, setIsLoadingIntensity] = useState<boolean>(true);

  const [heat, setHeat] = useState<HeatSourceId>("ASHP");
  const [annualHeatMWh, setAnnualHeatMWh] = useState<number>(10);
  const [gwpBioScale, setGwpBioScale] = useState<number>(100);
  const [copOverride, setCopOverride] = useState<string>("");
  const [districtCop, setDistrictCop] = useState<string>(String(DEFAULTS.district.cop));

  const [tempNowC, setTempNowC] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [coordinates, setCoordinates] = useState<Record<string, Coordinate>>({});
  const coordinateRequests = useRef<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;

    fetch("/data/monthly_full_release_long_format.csv")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to fetch CSV: ${response.status}`);
        }
        return response.text();
      })
      .then((text) => {
        if (cancelled) return;
        const parsed = Papa.parse(text, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
        }) as PapaParseResult<ParsedRow>;

        if (parsed.errors.length) {
          setIntensityError(parsed.errors[0]?.message ?? "CSV parse error");
          setIntensityHistory({});
          setEnergyMix({});
          setMixIntensity({});
          setAvailableCountries([]);
          setCountryNames({});
          setIsLoadingIntensity(false);
          return;
        }

        const history: IntensityHistory = {};
        const mixByIso: EnergyMixHistory = {};
        const intensityByIso: MixIntensityHistory = {};
        const names: Record<string, string> = {};
        const countryMap = new Map<string, CountryOption>();

        const parsedRows = parsed.data as IntensityRow[];
        const latestMix: Record<string, Partial<Record<MixCategory, { date: string; value: number }>>> = {};
        const latestEmissions: Record<string, Partial<Record<MixCategory, { date: string; value: number }>>> = {};

        const FUEL_TO_CATEGORY: Record<string, MixCategory> = {
          Nuclear: "Nuclear",
          Coal: "Coal",
          Gas: "Gas",
          Bioenergy: "Bioenergy",
          Hydro: "Hydro",
          Wind: "Wind",
          Solar: "Solar",
          "Other Fossil": "Other Fossil",
          "Other Renewables": "Other Renewables",
          Oil: "Other Fossil",
          Peat: "Other Fossil",
          Geothermal: "Other Renewables",
          Waste: "Other Renewables",
        };

        for (const rawRow of parsedRows) {
          if (!rawRow) continue;
          if (rawRow.Variable !== "CO2 intensity") continue;

          const iso3 = typeof rawRow["ISO 3 code"] === "string" ? rawRow["ISO 3 code"].trim().toUpperCase() : "";
          if (!iso3) continue;

          const areaName = typeof rawRow.Area === "string" && rawRow.Area.trim() ? rawRow.Area.trim() : iso3;
          const unit = typeof rawRow.Unit === "string" ? rawRow.Unit.toLowerCase().replace(/\s+/g, "") : "";
          if (!VALID_UNITS.has(unit)) continue;

          const value = Number(rawRow.Value);
          if (!Number.isFinite(value)) continue;

          const dateStr = String(rawRow.Date).slice(0, 10);
          if (!dateStr) continue;

          if (!history[iso3]) {
            history[iso3] = [];
          }
          history[iso3].push({ date: dateStr, value });

          if (!countryMap.has(iso3)) {
            countryMap.set(iso3, { iso3, name: areaName });
          }
          names[iso3] = areaName;
        }

        for (const rawRow of parsedRows) {
          if (!rawRow) continue;
          if (rawRow.Category !== "Electricity generation") continue;
          if (rawRow.Subcategory !== "Fuel") continue;
          const iso3 = typeof rawRow["ISO 3 code"] === "string" ? rawRow["ISO 3 code"].trim().toUpperCase() : "";
          if (!iso3) continue;
          const value = Number(rawRow.Value);
          if (!Number.isFinite(value)) continue;
          const dateStr = String(rawRow.Date).slice(0, 10);
          if (!dateStr) continue;
          const variable = rawRow.Variable ?? "";
          const category = FUEL_TO_CATEGORY[variable] ?? "Other";
          const buckets = latestMix[iso3] ?? (latestMix[iso3] = {});
          const entry = buckets[category];
          if (!entry || dateStr > entry.date) {
            buckets[category] = { date: dateStr, value };
          }
        }

        for (const rawRow of parsedRows) {
          if (!rawRow) continue;
          if (rawRow.Category !== "Electricity generation") continue;
          if (rawRow.Subcategory !== "Fuel") continue;
          const iso3 = typeof rawRow["ISO 3 code"] === "string" ? rawRow["ISO 3 code"].trim().toUpperCase() : "";
          if (!iso3) continue;
          const value = Number(rawRow.Value);
          if (!Number.isFinite(value)) continue;
          const dateStr = String(rawRow.Date).slice(0, 10);
          if (!dateStr) continue;
          const variable = rawRow.Variable ?? "";
          const category = FUEL_TO_CATEGORY[variable] ?? "Other";
          const buckets = latestMix[iso3] ?? (latestMix[iso3] = {});
          const entry = buckets[category];
          if (!entry || dateStr > entry.date) {
            buckets[category] = { date: dateStr, value };
          }
        }

        for (const rawRow of parsedRows) {
          if (!rawRow) continue;
          if (rawRow.Category !== "Power sector emissions") continue;
          if (rawRow.Subcategory !== "Fuel") continue;
          const iso3 = typeof rawRow["ISO 3 code"] === "string" ? rawRow["ISO 3 code"].trim().toUpperCase() : "";
          if (!iso3) continue;
          const value = Number(rawRow.Value);
          if (!Number.isFinite(value)) continue;
          const dateStr = String(rawRow.Date).slice(0, 10);
          if (!dateStr) continue;
          const variable = rawRow.Variable ?? "";
          const category = FUEL_TO_CATEGORY[variable] ?? "Other";
          const buckets = latestEmissions[iso3] ?? (latestEmissions[iso3] = {});
          const entry = buckets[category];
          if (!entry || dateStr > entry.date) {
            buckets[category] = { date: dateStr, value };
          }
        }

        Object.entries(latestMix).forEach(([iso3, bucket]) => {
          const total = Object.values(bucket).reduce((acc, info) => acc + (Number.isFinite(info?.value) ? info!.value : 0), 0);
          if (total <= 0) return;
          const grouped: Partial<Record<MixCategory, number>> = {};
          Object.entries(bucket).forEach(([category, info]) => {
            if (!info || !Number.isFinite(info.value)) return;
            const pct = (info.value / total) * 100;
            const key = category as MixCategory;
            grouped[key] = (grouped[key] ?? 0) + pct;
          });
          mixByIso[iso3] = grouped;
          const emissionBucket = latestEmissions[iso3] ?? {};
          const intensities: Partial<Record<MixCategory, number>> = {};
          Object.entries(bucket).forEach(([category, info]) => {
            if (!info || !Number.isFinite(info.value) || info.value <= 0) return;
            const emissionInfo = emissionBucket[category as MixCategory];
            if (!emissionInfo || !Number.isFinite(emissionInfo.value)) return;
            const rate = (emissionInfo.value / info.value) * 1000;
            intensities[category as MixCategory] = rate;
          });
          intensityByIso[iso3] = intensities;
        });

        Array.from(Object.keys(history)).forEach((iso3) => {
          history[iso3].sort((a, b) => a.date.localeCompare(b.date));
          if (history[iso3].length > 12) {
            history[iso3] = history[iso3].slice(-12);
          }
        });

        const sortedCountries = Array.from(countryMap.values()).sort((a, b) => a.name.localeCompare(b.name));

        setIntensityHistory(history);
        setEnergyMix(mixByIso);
        setMixIntensity(intensityByIso);
        setAvailableCountries(sortedCountries);
        setCountryNames(names);
        setIntensityError("");
        setIsLoadingIntensity(false);

        if (sortedCountries.length === 0) {
          setCountry("");
          return;
        }

        setCountry((prev) => {
          if (prev && names[prev]) {
            return prev;
          }
          const preferred = sortedCountries.find((option) => option.iso3 === "DEU") ?? sortedCountries[0];
          return preferred?.iso3 ?? "";
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setIntensityHistory({});
        setEnergyMix({});
        setMixIntensity({});
        setAvailableCountries([]);
        setCountryNames({});
        setIntensityError("Failed to load Ember CSV; using baseline intensities.");
        setIsLoadingIntensity(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCountryName = country ? countryNames[country] ?? country : "";
  const currentSeries = country ? intensityHistory[country] ?? [] : [];
  const hasSeries = currentSeries.length > 0;
  const countryMix = country ? energyMix[country] : undefined;
  const countryIntensity = country ? mixIntensity[country] : undefined;
  const baselineIntensity = country ? BASELINE_GRID_INTENSITY[country] ?? DEFAULT_BASELINE_INTENSITY : DEFAULT_BASELINE_INTENSITY;
  const latestEntry = hasSeries ? currentSeries[currentSeries.length - 1] : null;
  const gridIntensity = latestEntry ? latestEntry.value : baselineIntensity;
  const lastUpdated = latestEntry ? latestEntry.date : "";
  const gridSource = latestEntry ? "Ember monthly" : intensityError ? "baseline (error)" : "baseline";

  const recentHistory = hasSeries ? currentSeries.slice(-3).reverse() : [];

  const activeCoordinates = country ? coordinates[country] : undefined;
  const mixSlices: MixSlice[] = useMemo(() => {
    if (!countryMix) return [];
    const entries = Object.entries(countryMix).filter(([, value]) => value > 0) as [MixCategory, number][];
    if (!entries.length) return [];
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    const major = sorted.filter(([, value]) => value >= 2);
    const minorTotal = sorted
      .filter(([, value]) => value < 2)
      .reduce((acc, [, value]) => acc + value, 0);
    const slices: MixSlice[] = major.map(([category, value]) => ({
      category,
      label: MIX_LABELS[category],
      value,
      color: MIX_COLORS[category],
      emission: countryIntensity?.[category] ?? 0,
    }));
    if (minorTotal > 0.5) {
      const minorEmission = sorted
        .filter(([, share]) => share < 2)
        .reduce((acc, [category, share]) => {
          const intensity = countryIntensity?.[category] ?? 0;
          return acc + intensity * (share / minorTotal || 0);
        }, 0);
      slices.push({
        category: "Other",
        label: MIX_LABELS.Other,
        value: minorTotal,
        color: MIX_COLORS.Other,
        emission: minorEmission,
      });
    }
    return slices;
  }, [countryMix, countryIntensity]);

  useEffect(() => {
    if (!country) return;
    if (activeCoordinates) return;
    if (coordinateRequests.current[country]) return;
    const searchName = countryNames[country];
    if (!searchName) return;

    const controller = new AbortController();
    coordinateRequests.current[country] = true;

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=1&language=en&format=json`;

    fetch(url, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        const result = data?.results?.[0];
        if (result && typeof result.latitude === "number" && typeof result.longitude === "number") {
          setCoordinates((prev) => ({ ...prev, [country]: { lat: result.latitude, lon: result.longitude } }));
        }
      })
      .catch((error) => {
        console.error("Geocoding failed", error);
      })
      .finally(() => {
        delete coordinateRequests.current[country];
      });

    return () => {
      controller.abort();
      delete coordinateRequests.current[country];
    };
  }, [country, countryNames, activeCoordinates]);

  useEffect(() => {
    if (!country) {
      setTempNowC(null);
      return;
    }

    if (!activeCoordinates) {
      setTempNowC(null);
      return;
    }

    const controller = new AbortController();
    const { lat, lon } = activeCoordinates;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`;

    fetch(url, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        const t = data?.current?.temperature_2m;
        if (typeof t === "number") {
          setTempNowC(t);
        } else {
          setTempNowC(null);
        }
      })
      .catch((error) => {
        console.error("Temperature fetch failed", error);
        setTempNowC(null);
      });

    return () => controller.abort();
  }, [country, activeCoordinates?.lat, activeCoordinates?.lon]);

  const effectiveCOP = useMemo(() => {
    if (heat === "ASHP") {
      const t = tempNowC ?? 5;
      const base = ashpCOP(t);
      return copOverride.trim() ? Number(copOverride) : base;
    }

    if (heat === "GSHP") {
      const base = gshpCOP();
      return copOverride.trim() ? Number(copOverride) : base;
    }

    if (heat === "DH") {
      const parsed = Number(districtCop);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.district.cop;
    }

    return 1;
  }, [heat, tempNowC, copOverride, districtCop]);

  useEffect(() => {
    if (heat !== "DH") {
      setDistrictCop(String(DEFAULTS.district.cop));
    }
  }, [heat]);

  const emissionsPerKWhHeatThisYear = (grid_g_per_kWh: number): IntensitySummary => {
    const friendlyLabel = HEAT_SOURCES.find((entry) => entry.id === heat)?.label ?? heat;
    switch (heat) {
      case "ASHP":
      case "GSHP":
      case "DH": {
        const cop = effectiveCOP;
        return { comparator: grid_g_per_kWh / cop, label: `${friendlyLabel} (COP ${cop.toFixed(2)})` };
      }
      case "RESISTIVE": {
        return { comparator: grid_g_per_kWh, label: friendlyLabel };
      }
      case "GAS": {
        const e = DEFAULTS.gas.efCO2_fuel_g_per_kWh / DEFAULTS.gas.boilerEff;
        return { comparator: e, label: "Gas boiler" };
      }
      case "OIL": {
        const e = DEFAULTS.oil.efCO2_fuel_g_per_kWh / DEFAULTS.oil.boilerEff;
        return { comparator: e, label: "Oil boiler" };
      }
      default:
        return { comparator: grid_g_per_kWh / 3.5, label: "Heat" };
    }
  };

  const woodEmissions_g_per_kWh = (horizon: number) => {
    const gwp = (BASE_GWPBIO[horizon] ?? 0.5) * (gwpBioScale / 100);
    const co2 = (DEFAULTS.wood.efCO2_fuel_g_per_kWh * gwp) / DEFAULTS.wood.stoveEff;
    const nonCO2 = DEFAULTS.wood.efCH4N2O_g_per_kWh / DEFAULTS.wood.stoveEff;
    return co2 + nonCO2;
  };

  const intensityPathForHorizon = (horizon: number, todayIntensity: number) => {
    const now = new Date();
    const year = now.getFullYear();
    return gridIntensityPath(
      year,
      horizon,
      todayIntensity,
      DEFAULTS.kyoto.targetYear,
      DEFAULTS.kyoto.targetGridIntensity_g_per_kWh
    );
  };

  const cumulativeForHorizon = (horizon: number, todayIntensity: number) => {
    const annualKWh = annualHeatMWh * 1000;
    const path = intensityPathForHorizon(horizon, todayIntensity);
    let comp = 0;
    let wood = 0;
    const woodPerKWh = woodEmissions_g_per_kWh(horizon);
    for (let i = 0; i < horizon; i += 1) {
      const gridValue = path[i];
      const { comparator: eComp } = emissionsPerKWhHeatThisYear(gridValue);
      comp += eComp * annualKWh;
      wood += woodPerKWh * annualKWh;
    }
    const diff = comp - wood;
    const diffPct = comp > 0 ? (diff / comp) * 100 : 0;
    return { wood, comp, diff, diffPct };
  };

  const rows = useMemo(() => {
    return HORIZONS.map((horizon) => {
      const { wood, comp, diff, diffPct } = cumulativeForHorizon(horizon, gridIntensity);
      return {
        horizon,
        wood_t: wood / 1_000_000,
        comp_t: comp / 1_000_000,
        diff_t: diff / 1_000_000,
        diffPct,
      };
    });
  }, [gridIntensity, annualHeatMWh, heat, effectiveCOP, gwpBioScale]);

  const selectedHeatLabel = HEAT_SOURCES.find((entry) => entry.id === heat)?.label ?? "Heat";
  const today = new Date().toISOString().slice(0, 10);
  const comparatorLabel = emissionsPerKWhHeatThisYear(gridIntensity).label;
  const tenYearSnapshot = useMemo(() => {
    const horizonYears = 10;
    const totals = cumulativeForHorizon(horizonYears, gridIntensity);
    const totalKWh = annualHeatMWh * 1000 * horizonYears;
    if (totalKWh <= 0) {
      return { woodPerKWh: 0, heatingPerKWh: 0, diffPerKWh: 0 };
    }
    const woodPerKWh = totals.wood / totalKWh;
    const heatingPerKWh = totals.comp / totalKWh;
    return {
      woodPerKWh,
      heatingPerKWh,
      diffPerKWh: heatingPerKWh - woodPerKWh,
    };
  }, [annualHeatMWh, gridIntensity, heat, effectiveCOP, gwpBioScale]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold">I&apos;m cold. Should I burn wood or use my heating system?</h1>
          <p className="text-sm text-slate-600">Today: {today}</p>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-medium text-slate-800">Scenario</h2>
              <div className="mt-3 flex flex-col gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-slate-700">Country</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                    value={country}
                    onChange={(event) => setCountry(event.target.value)}
                    disabled={!availableCountries.length && !intensityError}
                  >
                    {availableCountries.length === 0 ? (
                      <option value="">
                        {isLoadingIntensity ? "Loading countries…" : "No Ember data available"}
                      </option>
                    ) : (
                      availableCountries.map((option) => (
                        <option key={option.iso3} value={option.iso3}>
                          {option.name} ({option.iso3})
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="font-medium text-slate-700">Heat source (vs. wood)</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                    value={heat}
                    onChange={(event) => setHeat(event.target.value as HeatSourceId)}
                  >
                    {HEAT_SOURCES.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </label>

                {heat === "DH" && (
                <></>
              )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-medium text-slate-800">Details &amp; Explanation</h2>
                <button
                  type="button"
                  className="rounded-md border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {advancedOpen ? "Hide details" : "Show details"}
                </button>
              </div>
              {advancedOpen && (
                <div className="mt-4 space-y-4 text-sm">
                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="text-sm font-medium text-slate-800">How the math works</h3>
                    <ul className="mt-3 list-disc space-y-2 pl-5 text-xs text-slate-600">
                      <li>
                        Wood emissions = ((403 g CO₂ × GWPbio factor) + 30 g CH₄/N₂O) ÷ stove efficiency. GWPbio factors scale with the slider and follow default residues timing (1–1000y).
                      </li>
                      <li>
                        Electric heat emissions = grid intensity ÷ COP. Resistive heating uses COP 1; district heating uses the entered COP. Gas and oil emissions divide the default fuel factors by boiler efficiency.
                      </li>
                      <li>
                        Kyoto path linearly declines from today’s grid intensity toward {DEFAULTS.kyoto.targetGridIntensity_g_per_kWh} g/kWh_e by {DEFAULTS.kyoto.targetYear}; cumulative totals sum annual emissions across the chosen horizon.
                      </li>
                      <li>
                        Ten-year snapshot averages wood and comparison emissions over 10 × annual demand (in kWh_heat) to show per-kWh CO₂e with all timing adjustments applied.
                      </li>
                    </ul>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
                    Why does burning wood for heat lose out so often, even compared to fossil fuels, even though it is a closed-cycle renewable
                    resource? Don&apos;t trees regrow, soaking carbon from the air? True, but: when you burn wood, you dump decades of stored carbon
                    into the air at once, but the trees that might reabsorb it grow back slowly. The result is a long interim where the atmosphere
                    holds more CO₂ than it otherwise would. Add the soot and methane from imperfect combustion, and the short-term effect is warming.
                    The balance evens out only far in the future, but over the critical next few decades, the pulse of heat-trapping gases from burning
                    wood is greater than from most other heating methods.
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="text-sm font-medium text-slate-800">Grid data</h3>
                    <div className="mt-3 flex flex-col gap-3 text-sm text-slate-700">
                      <p>
                        Bundled Ember monthly CSV loads automatically; {availableCountries.length} country
                        {availableCountries.length === 1 ? "" : "ies"} detected.
                      </p>
                      <p className="text-xs text-slate-600">
                        Current grid intensity: {formatNumber(gridIntensity)} g/kWh_e ({gridSource}
                        {lastUpdated ? `, ${lastUpdated}` : ""})
                      </p>
                      {hasSeries && (
                        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                          <p className="font-semibold text-slate-700">Recent months — {selectedCountryName}</p>
                          <ul className="mt-2 space-y-1">
                            {recentHistory.map((entry) => (
                              <li key={entry.date}>
                                {entry.date}: {entry.value.toFixed(1)} g/kWh_e
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!hasSeries && (
                        <p className="text-xs text-slate-600">
                          No CO₂ intensity rows for this country in the bundled CSV; falling back to baseline estimates.
                        </p>
                      )}
                      {intensityError && <p className="text-xs text-rose-600">{intensityError}</p>}
                      {mixSlices.length > 0 && (
                        <div className="mt-4 flex flex-col gap-2">
                          <div className="text-xs font-semibold uppercase text-slate-600">Latest electricity mix (share &amp; gCO₂/kWh)</div>
                          <svg viewBox="0 0 32 32" className="h-40 w-40 self-center">
                            {(() => {
                              let cumulative = 0;
                              return mixSlices.map((slice, index) => {
                                const start = (cumulative / 100) * Math.PI * 2;
                                cumulative += slice.value;
                                const end = (cumulative / 100) * Math.PI * 2;
                                const largeArc = end - start > Math.PI ? 1 : 0;
                                const x1 = 16 + 16 * Math.sin(start);
                                const y1 = 16 - 16 * Math.cos(start);
                                const x2 = 16 + 16 * Math.sin(end);
                                const y2 = 16 - 16 * Math.cos(end);
                                const d = `M16 16 L ${x1} ${y1} A 16 16 0 ${largeArc} 1 ${x2} ${y2} Z`;
                                return (
                                  <path
                                    key={`${slice.category}-${index}`}
                                    d={d}
                                    fill={slice.color}
                                    stroke="#fff"
                                    strokeWidth={0.5}
                                  />
                                );
                              });
                            })()}
                            <circle cx="16" cy="16" r="8" fill="#fff" stroke="#fff" strokeWidth={0.5} />
                          </svg>
                          <ul className="grid grid-cols-2 gap-3 text-xs text-slate-600">
                            {mixSlices.map((slice) => (
                              <li key={slice.category} className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: slice.color }} />
                                  <span className="truncate">{slice.label}</span>
                                  <span className="ml-auto font-medium text-slate-700">{slice.value.toFixed(1)}%</span>
                                </div>
                                <div className="pl-5 text-[11px] text-slate-500">
                                  {slice.emission && slice.emission > 0
                                    ? `≈ ${slice.emission.toFixed(0)} gCO₂/kWh`
                                    : slice.emission === 0
                                    ? "≈ 0 gCO₂/kWh"
                                    : "—"}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>

                  {(heat === "ASHP" || heat === "GSHP") && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-col gap-2 text-xs text-slate-700">
                        <label className="flex flex-col gap-1">
                          <span className="font-semibold">Override heat pump COP</span>
                          <input
                            type="number"
                            step="0.1"
                            placeholder="e.g., 3.2"
                            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                            value={copOverride}
                            onChange={(event) => setCopOverride(event.target.value)}
                          />
                        </label>
                        <p className="text-slate-600">
                          {heat === "ASHP" && (
                            <>
                              Ambient {tempNowC == null ? "…" : `${tempNowC.toFixed(1)}°C`} → model COP ≈ {ashpCOP(tempNowC ?? 5).toFixed(2)}
                            </>
                          )}
                          {heat === "GSHP" && <>Baseline COP ≈ {gshpCOP().toFixed(2)}</>}
                        </p>
                      </div>
                    </div>
                  )}

                  {heat === "DH" && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-col gap-2 text-xs text-slate-700">
                        <label className="flex flex-col gap-1">
                          <span className="font-semibold">District effective COP</span>
                          <input
                            type="number"
                            min={0.1}
                            step={0.1}
                            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                            value={districtCop}
                            onChange={(event) => setDistrictCop(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  <label className="flex flex-col gap-1">
                    <span className="font-medium text-slate-700">Annual heat demand (MWh/yr)</span>
                    <input
                      type="number"
                      min={1}
                      step={0.5}
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                      value={annualHeatMWh}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setAnnualHeatMWh(Number.isFinite(next) ? next : annualHeatMWh);
                      }}
                    />
                  </label>

                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="text-sm font-medium text-slate-800">Biogenic CO₂ timing</h3>
                    <div className="mt-3 flex flex-col gap-3">
                      <label className="flex flex-col gap-2">
                        <span className="font-medium text-slate-700">GWPbio scaling</span>
                        <input
                          type="range"
                          min={25}
                          max={150}
                          step={5}
                          value={gwpBioScale}
                          onChange={(event) => setGwpBioScale(Number(event.target.value))}
                        />
                        <span className="text-xs text-slate-600">{gwpBioScale}% of base factors (1y {BASE_GWPBIO[1]}, 30y {BASE_GWPBIO[30]}, 100y {BASE_GWPBIO[100]})</span>
                      </label>
                      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                        <div className="flex items-center gap-2 font-semibold text-slate-700">
                          <Info size={14} />
                          <span>Assumptions</span>
                        </div>
                        <ul className="mt-2 list-disc space-y-1 pl-4">
                          <li>
                            Wood: 403 g CO₂ + 30 g CH₄/N₂O per kWh_fuel, stove efficiency 0.75.
                          </li>
                          <li>
                            Gas: 202 g CO₂ per kWh_fuel, boiler efficiency 0.92; Oil: 267 g CO₂, efficiency 0.90.
                          </li>
                          <li>
                            Kyoto path to {DEFAULTS.kyoto.targetGridIntensity_g_per_kWh} g/kWh_e by {DEFAULTS.kyoto.targetYear}.
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="text-sm font-medium text-slate-800">Summary</h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Comparing wood stove against {selectedHeatLabel}. Table values assume {formatNumber(annualHeatMWh)} MWh/year and {comparatorLabel} emissions.
                    </p>
                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                            <th className="py-2">Horizon (years)</th>
                            <th className="py-2">Wood (tCO₂e)</th>
                            <th className="py-2">{comparatorLabel} (tCO₂e)</th>
                            <th className="py-2">Diff (comp − wood)</th>
                            <th className="py-2">Diff %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.horizon} className="border-b border-slate-100">
                              <td className="py-2 font-medium text-slate-700">{row.horizon}</td>
                              <td className="py-2 text-slate-700">{row.wood_t.toFixed(2)}</td>
                              <td className="py-2 text-slate-700">{row.comp_t.toFixed(2)}</td>
                              <td className={`py-2 font-medium ${row.diff_t > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                {row.diff_t > 0 ? "+" : ""}
                                {row.diff_t.toFixed(2)}
                              </td>
                              <td className="py-2 text-slate-700">{row.diffPct.toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-medium text-slate-800">10-year CO₂e snapshot</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <img src="/data/fireplace.png" alt="Wood heating" className="h-12 w-12 object-contain" />
                    <h3 className="text-sm font-semibold text-slate-700">Wood CO₂e / kWh (g)</h3>
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="text-3xl font-semibold leading-none text-slate-800">{formatNumber(tenYearSnapshot.woodPerKWh, 1)}</div>
                    <div className="text-xs text-slate-500">10-year horizon (biogenic timing applied)</div>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <img src="/data/heater.png" alt={selectedHeatLabel} className="h-12 w-12 object-contain" />
                    <h3 className="text-sm font-semibold text-slate-700">{selectedHeatLabel} CO₂e / kWh (g)</h3>
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="text-3xl font-semibold leading-none text-slate-800">{formatNumber(tenYearSnapshot.heatingPerKWh, 1)}</div>
                    <div className="text-xs text-slate-500">Average of 10-year Kyoto path</div>
                  </div>
                </div>
              </div>
              <div className="mt-4 text-sm text-slate-600">
                Difference (heating − wood, g/kWh):
                <span
                  className={`ml-1 font-semibold ${
                    tenYearSnapshot.diffPerKWh > 0 ? "text-emerald-600" : tenYearSnapshot.diffPerKWh < 0 ? "text-rose-600" : "text-slate-700"
                  }`}
                >
                  {tenYearSnapshot.diffPerKWh > 0 ? "+" : ""}
                  {formatNumber(tenYearSnapshot.diffPerKWh, 1)}
                </span>
              </div>
            </div>

            {advancedOpen && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-base font-medium text-slate-800">Notes</h2>
                <ul className="mt-3 list-disc space-y-2 pl-4 text-sm text-slate-600">
                  <li>All countries present in the bundled Ember CSV are selectable; latest 12 months drive the comparison.</li>
                  <li>Outside temperature comes from Open-Meteo geocoding + forecast; override COP if you have metered data.</li>
                  <li>Kyoto path linearly reduces electricity emissions from today&apos;s value to the 2050 target.</li>
                </ul>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default WoodVsHeatApp;
