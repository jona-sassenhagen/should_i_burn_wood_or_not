# Wood heat CO₂e with GWPbio — quick guide

## What you compute
Per **kWh of useful heat** from wood, at time-horizon **H**:
```
CO2e_wood(H) = (403 * GWPbio(H) + 30) / η     [g CO₂e per kWh_th]
```
- **403** = g CO₂ per kWh of wood fuel (dry, LHV).
- **30** = g CO₂e per kWh_fuel from CH₄+N₂O.
- **η** = appliance efficiency (stove/boiler), e.g. 0.75–0.85.
- **GWPbio(H)** down-weights biogenic CO₂ to reflect eventual re-uptake over horizon **H**.
Optional for small stoves at short horizons: add a black carbon term (tens of gCO₂e/kWh_th).

## Biome → GWPbio(H) (rough, residues/forest fuel)
| Biome | GWPbio(20y) | GWPbio(30y) | GWPbio(100y) | GWPbio(1000y) |
|---|---:|---:|---:|---:|
| Boreal | 0.90 | 0.85 | 0.60 | 0.30 |
| Temperate | 0.80 | 0.70 | 0.50 | 0.25 |
| Tropical | 0.50 | 0.40 | 0.30 | 0.15 |
| Arid/semi-arid | 0.95 | 0.90 | 0.70 | 0.35 |

## Minimal ISO2 → biome mapping
Use this to pick the GWPbio row for a country. Edit as needed.
```json
{
  "DE": "temperate", "FR": "temperate", "PL": "temperate", "NL": "temperate",
  "BE": "temperate", "LU": "temperate", "DK": "temperate",
  "SE": "boreal", "FI": "boreal", "NO": "boreal", "EE": "boreal", "LV": "boreal", "LT": "boreal",
  "IE": "temperate", "GB": "temperate", "IS": "boreal",
  "ES": "temperate", "PT": "temperate", "IT": "temperate", "GR": "temperate",
  "AT": "temperate", "CH": "temperate", "CZ": "temperate", "SK": "temperate",
  "HU": "temperate", "SI": "temperate", "HR": "temperate", "RO": "temperate",
  "BG": "temperate", "RS": "temperate", "BA": "temperate", "MK": "temperate",
  "UA": "temperate", "BY": "boreal", "MD": "temperate",
  "RU": "boreal",
  "US": "temperate", "CA": "boreal", "MX": "tropical",
  "BR": "tropical", "AR": "temperate", "CL": "temperate", "PE": "tropical",
  "CO": "tropical", "VE": "tropical", "EC": "tropical", "BO": "tropical",
  "UY": "temperate", "PY": "tropical", "GY": "tropical", "SR": "tropical",
  "CN": "temperate", "JP": "temperate", "KR": "temperate", "MN": "boreal",
  "IN": "tropical", "BD": "tropical", "PK": "temperate", "NP": "temperate",
  "LK": "tropical", "MM": "tropical", "TH": "tropical", "VN": "tropical",
  "LA": "tropical", "KH": "tropical", "MY": "tropical", "SG": "tropical",
  "ID": "tropical", "PH": "tropical",
  "AU": "temperate", "NZ": "temperate",
  "ZA": "temperate", "NA": "arid", "BW": "arid", "MZ": "tropical",
  "TZ": "tropical", "KE": "tropical", "UG": "tropical", "ET": "tropical",
  "NG": "tropical", "GH": "tropical", "CI": "tropical", "CM": "tropical",
  "CD": "tropical", "GA": "tropical", "CG": "tropical",
  "DZ": "arid", "MA": "arid", "TN": "arid", "EG": "arid", "SA": "arid",
  "IR": "temperate", "IQ": "arid", "TR": "temperate"
}
```

## Example
Germany (temperate), η = 0.75, H = 30 y:
```
CO2e_wood(30) = (403 * 0.70 + 30) / 0.75 ≈ 416 g CO₂e/kWh_th
```
If η = 0.85 → ≈ 367 g/kWh_th. If H = 100 y (GWPbio=0.50) → ≈ 309 g/kWh_th.
