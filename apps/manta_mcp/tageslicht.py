from __future__ import annotations

import datetime
import math

_r, _d = math.radians, math.degrees

ZENITH = 90.833

RUECKSCHAU_TAGE = 400

METHOD = (
    "Day length from the NOAA solar calculation: solar declination for the local solar noon of "
    "that date, then the sunrise hour angle at a zenith of 90.833° (refraction plus the solar "
    "radius). Closed form, no fitting and no estimation — it follows from the station's latitude "
    "and the sample's date and from nothing else. 0 h and 24 h are the two clamped cases: the "
    "sun stays below or above the horizon all day.")

REFERENCE = (
    "NOAA Global Monitoring Laboratory, Solar Calculation Details "
    "(https://gml.noaa.gov/grad/solcalc/calcdetails.html), after Meeus, Astronomical Algorithms, "
    "2nd ed. 1998. Checked against U.S. Naval Observatory rise/set times for 79.0118°N: the "
    "start of the polar night 2016/17 to the day, its end one day late (first sun computed on "
    "2017-02-18, USNO 2017-02-17). Because the declination is taken once per local noon, the "
    "edges of the polar day can likewise be off by one day (24 h computed on a day with a brief "
    "sunset).")

NOT_ECOLOGY = (
    "This is an ASTRONOMICAL statement, not an ecological one. \"Polar night\" here means the "
    "computed day length is 0 h — nothing more. It says nothing about growth, dormancy, blooms "
    "or light limitation, and MANTA does not derive any such claim from it.")

ABSENT_NO_STATION = (
    "No day length: this dataset has no station, so there is no latitude to compute it from.")
ABSENT_NO_DATES = (
    "No day length: this dataset's samples carry an order, not calendar dates. The computation "
    "needs a real date.")


def declination(datum: datetime.date, lon: float = 0.0) -> float:
    a = (14 - datum.month) // 12
    y = datum.year + 4800 - a
    m = datum.month + 12 * a - 3
    jdn = datum.day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    jd = jdn - lon / 360.0
    T = (jd - 2451545.0) / 36525.0
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    C = (math.sin(_r(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
         + math.sin(_r(2 * M)) * (0.019993 - 0.000101 * T)
         + math.sin(_r(3 * M)) * 0.000289)
    lam = L0 + C - 0.00569 - 0.00478 * math.sin(_r(125.04 - 1934.136 * T))
    eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps += 0.00256 * math.cos(_r(125.04 - 1934.136 * T))
    return _d(math.asin(math.sin(_r(eps)) * math.sin(_r(lam))))


def daylength_hours(lat: float, datum: datetime.date, lon: float = 0.0) -> float:
    dec = declination(datum, lon)
    nenner = math.cos(_r(lat)) * math.cos(_r(dec))
    if nenner == 0:
        return 12.0
    x = math.cos(_r(ZENITH)) / nenner - math.tan(_r(lat)) * math.tan(_r(dec))
    if x > 1.0:
        return 0.0
    if x < -1.0:
        return 24.0
    return 8.0 * _d(math.acos(x)) / 60.0


def is_polar_night(lat: float, datum: datetime.date, lon: float = 0.0) -> bool:
    return daylength_hours(lat, datum, lon) == 0.0


def is_polar_day(lat: float, datum: datetime.date, lon: float = 0.0) -> bool:
    return daylength_hours(lat, datum, lon) == 24.0


def days_since_sun_return(lat: float, datum: datetime.date, lon: float = 0.0) -> "int | None":
    heute = is_polar_night(lat, datum, lon)
    vorher = heute
    d = datum
    for schritt in range(1, RUECKSCHAU_TAGE + 1):
        d = datum - datetime.timedelta(days=schritt)
        jetzt = is_polar_night(lat, d, lon)
        if jetzt and not vorher:
            return schritt - 1
        vorher = jetzt
    return None


def light(lat: "float | None", datum: "datetime.date | None",
          lon: float = 0.0) -> dict:
    if lat is None:
        return {"available": False, "absent_reason": ABSENT_NO_STATION,
                "day_length_h": None, "polar_night": None, "polar_day": None,
                "days_since_sun_return": None}
    if datum is None:
        return {"available": False, "absent_reason": ABSENT_NO_DATES,
                "day_length_h": None, "polar_night": None, "polar_day": None,
                "days_since_sun_return": None}
    h = daylength_hours(lat, datum, lon)
    return {"available": True,
            "day_length_h": round(h, 4),
            "polar_night": h == 0.0,
            "polar_day": h == 24.0,
            "days_since_sun_return": days_since_sun_return(lat, datum, lon)}


def bands(lat: float, von: datetime.date, bis: datetime.date,
          lon: float = 0.0) -> list[dict]:
    if bis < von:
        von, bis = bis, von
    aus: list[dict] = []
    offen: "dict | None" = None
    d = von
    while d <= bis:
        h = daylength_hours(lat, d, lon)
        art = "polar_night" if h == 0.0 else ("polar_day" if h == 24.0 else None)
        if offen and offen["kind"] != art:
            offen["end"] = (d - datetime.timedelta(days=1)).isoformat()
            aus.append(offen)
            offen = None
        if art and not offen:
            offen = {"kind": art, "start": d.isoformat(), "end": None,
                     "clipped_start": d == von, "clipped_end": False}
        d += datetime.timedelta(days=1)
    if offen:
        offen["end"] = bis.isoformat()
        offen["clipped_end"] = True
        aus.append(offen)
    return aus
