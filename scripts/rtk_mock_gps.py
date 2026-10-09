#!/usr/bin/env python3
"""
RTK Mock GPS Injector — simulates RTK-grade GPS fixes with full satellite
constellation data, injected to an Android device via USB/ADB.

Generates realistic NMEA sentences (GGA, GSV, GSA, RMC, VTG, GLL) with
proper satellite PRNs, elevations, azimuths, and SNRs for GPS + GLONASS +
Galileo constellations. Location is injected via Android's `cmd location`
test provider API. NMEA stream is also logged to file for USB serial piping.

Prerequisites:
  - Android device connected via USB with USB debugging enabled
  - adb in PATH
  - No root or companion app needed

Usage:
  python3 rtk_mock_gps.py                          # Drohobych defaults, 120s
  python3 rtk_mock_gps.py --jitter                 # Add realistic RTK drift
  python3 rtk_mock_gps.py --duration 600 --interval 0.5  # 10min, 2Hz
  python3 rtk_mock_gps.py --nmea-file /dev/tty.usbserial  # Pipe NMEA to serial
"""

import argparse
import subprocess
import sys
import time
import random
import math
import os
from datetime import datetime, timezone


# ─── ADB helpers ──────────────────────────────────────────────────────────

def adb(args: list[str], check: bool = True) -> str:
    cmd = ["adb"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"ADB error: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def check_device() -> str:
    devices = adb(["devices"])
    lines = [l for l in devices.splitlines() if "\tdevice" in l]
    if not lines:
        print("No USB device found. Connect device and enable USB debugging.", file=sys.stderr)
        sys.exit(1)
    serial = lines[0].split("\t")[0]
    print(f"Connected device: {serial}")
    return serial


def setup_test_provider():
    adb(["shell", "settings", "put", "secure", "mock_location", "1"])
    adb(["shell", "appops", "set", "2000", "android:mock_location", "allow"])
    adb(["shell", "cmd", "location", "providers", "add-test-provider", "gps",
         "--supportsAltitude", "--supportsSpeed", "--supportsBearing"])
    adb(["shell", "cmd", "location", "providers", "set-test-provider-enabled", "gps", "true"])
    print("Test provider registered and enabled.")


def cleanup_test_provider():
    try:
        adb(["shell", "cmd", "location", "providers", "remove-test-provider", "gps"], check=False)
        print("\nTest provider removed.")
    except Exception:
        pass


# ─── Satellite constellation simulation ───────────────────────────────────

class Satellite:
    """Represents a single satellite with orbital geometry."""
    def __init__(self, prn: int, constellation: str, elev: float, azim: float, snr: float):
        self.prn = prn
        self.constellation = constellation  # GP, GL, GA
        self.elevation = elev
        self.azimuth = azim
        self.snr = snr

    @property
    def nmea_prefix(self) -> str:
        return self.constellation

    @property
    def talker_prn(self) -> int:
        """PRN as used in NMEA sentences (constellation-specific)."""
        return self.prn


def generate_constellation(seed: int = 42) -> list[Satellite]:
    """
    Generate a realistic satellite constellation visible from Drohobych (~49.35°N, 23.49°E).
    Simulates GPS (PRN 1-32), GLONASS (PRN 65-96), and Galileo (PRN 1-36 → offset 200).

    Returns ~30 satellites with realistic elevation/azimuth/SNR distribution.
    """
    rng = random.Random(seed)
    sats = []

    # GPS satellites (PRN 1-32) — ~12-16 visible above 5° elevation
    gps_count = 0
    for prn in range(1, 33):
        elev = rng.uniform(5, 88) if rng.random() < 0.45 else rng.uniform(0, 5)
        if elev < 5:
            continue
        azim = rng.uniform(0, 360)
        # SNR correlates with elevation: higher elev → higher SNR
        base_snr = 15 + (elev / 90) * 30
        snr = base_snr + rng.gauss(0, 3)
        snr = max(0, min(55, snr))
        sats.append(Satellite(prn, "GP", elev, azim, snr))
        gps_count += 1

    # GLONASS satellites (PRN 65-96) — ~8-10 visible
    for prn in range(65, 97):
        elev = rng.uniform(5, 85) if rng.random() < 0.35 else rng.uniform(0, 5)
        if elev < 5:
            continue
        azim = rng.uniform(0, 360)
        base_snr = 12 + (elev / 90) * 28
        snr = base_snr + rng.gauss(0, 3)
        snr = max(0, min(50, snr))
        sats.append(Satellite(prn, "GL", elev, azim, snr))

    # Galileo satellites (PRN 1-36, NMEA uses 200+ range) — ~7-9 visible
    for prn in range(1, 37):
        elev = rng.uniform(5, 82) if rng.random() < 0.30 else rng.uniform(0, 5)
        if elev < 5:
            continue
        azim = rng.uniform(0, 360)
        base_snr = 14 + (elev / 90) * 29
        snr = base_snr + rng.gauss(0, 3)
        snr = max(0, max(0, min(52, snr)))
        sats.append(Satellite(prn + 200, "GA", elev, azim, snr))

    # Sort by elevation (highest first) — realistic for GSV
    sats.sort(key=lambda s: -s.elevation)
    return sats


def update_satellite_snr(sats: list[Satellite], tick: int):
    """Apply slow SNR fluctuations to simulate atmospheric effects."""
    for sat in sats:
        # Slow oscillation + small noise
        sat.snr += math.sin(tick * 0.05 + sat.prn * 0.7) * 0.3
        sat.snr += random.gauss(0, 0.2)
        sat.snr = max(0, min(55, sat.snr))


def select_active_satellites(sats: list[Satellite], count: int = 12) -> list[Satellite]:
    """Select the best satellites for the RTK fix (highest SNR/elevation)."""
    # Prefer GPS, then Galileo, then GLONASS — typical for RTK
    eligible = [s for s in sats if s.snr > 20 and s.elevation > 10]
    eligible.sort(key=lambda s: (s.constellation != "GP", -s.snr))
    return eligible[:count]


# ─── NMEA sentence builders ───────────────────────────────────────────────

def nmea_checksum(body: str) -> str:
    ck = 0
    for ch in body:
        ck ^= ord(ch)
    return f"{ck:02X}"


def nmea_sentence(talker: str, body: str) -> str:
    return f"${talker}{body}*{nmea_checksum(body)}"


def fmt_lat(lat: float) -> tuple[str, str]:
    ns = "N" if lat >= 0 else "S"
    lat_abs = abs(lat)
    deg = int(lat_abs)
    minutes = (lat_abs - deg) * 60.0
    return f"{deg:02d}{minutes:07.4f}", ns


def fmt_lon(lon: float) -> tuple[str, str]:
    ew = "E" if lon >= 0 else "W"
    lon_abs = abs(lon)
    deg = int(lon_abs)
    minutes = (lon_abs - deg) * 60.0
    return f"{deg:03d}{minutes:07.4f}", ew


def utc_time() -> str:
    return datetime.now(timezone.utc).strftime("%H%M%S")


def utc_date() -> str:
    return datetime.now(timezone.utc).strftime("%d%m%y")


def build_gga(lat: float, lon: float, alt: float, quality: int = 4,
              sats_used: int = 12, hdop: float = 0.4, geoid: float = 31.0) -> str:
    """GGA — Fix data. quality=4 → RTK fixed."""
    lat_str, ns = fmt_lat(lat)
    lon_str, ew = fmt_lon(lon)
    body = (
        f"GGA,{utc_time()}.00,"
        f"{lat_str},{ns},{lon_str},{ew},"
        f"{quality},{sats_used:02d},{hdop:.1f},"
        f"{alt:.1f},M,{geoid:.1f},M,,"
    )
    return nmea_sentence("GP", body)


def build_gsa(active_sats: list[Satellite], hdop: float = 0.4,
              vdop: float = 0.6, mode: str = "3") -> list[str]:
    """GSA — Active satellites and DOP. mode=3 → 3D fix, mode=4 → RTK."""
    # Use mode 4 for RTK fixed
    fix_mode = "4" if mode == "3" else mode
    prns = [s.talker_prn for s in active_sats[:12]]
    while len(prns) < 12:
        prns.append("")

    # GPS GSA
    prn_str = ",".join(str(p) if p else "" for p in prns)
    body = f"SA,A,{fix_mode},{prn_str},{hdop:.1f},{vdop:.1f},"
    sentences = [nmea_sentence("GP", body)]

    # GLONASS GSA (if any GLONASS sats active)
    glonass_active = [s for s in active_sats if s.constellation == "GL"]
    if glonass_active:
        gl_prns = [s.talker_prn - 64 for s in glonass_active[:12]]  # GLONASS uses 1-24
        while len(gl_prns) < 12:
            gl_prns.append("")
        gl_str = ",".join(str(p) if p else "" for p in gl_prns)
        body_gl = f"SA,A,{fix_mode},{gl_str},{hdop:.1f},{vdop:.1f},"
        sentences.append(nmea_sentence("GL", body_gl))

    # Galileo GSA
    galileo_active = [s for s in active_sats if s.constellation == "GA"]
    if galileo_active:
        ga_prns = [s.talker_prn - 200 for s in galileo_active[:12]]
        while len(ga_prns) < 12:
            ga_prns.append("")
        ga_str = ",".join(str(p) if p else "" for p in ga_prns)
        body_ga = f"SA,A,{fix_mode},{ga_str},{hdop:.1f},{vdop:.1f},"
        sentences.append(nmea_sentence("GA", body_ga))

    return sentences


def build_gsv(sats: list[Satellite]) -> list[str]:
    """GSV — Satellites in view. Max 4 sats per sentence."""
    sentences = []

    # Group by constellation
    constellations = {"GP": [], "GL": [], "GA": []}
    for sat in sats:
        if sat.constellation in constellations:
            constellations[sat.constellation].append(sat)

    for const_prefix, const_sats in constellations.items():
        if not const_sats:
            continue

        total_sats = len(const_sats)
        total_sentences = math.ceil(total_sats / 4)

        for i in range(total_sentences):
            chunk = const_sats[i * 4:(i + 1) * 4]
            sat_fields = []
            for sat in chunk:
                prn = sat.talker_prn
                if const_prefix == "GL":
                    prn = sat.talker_prn - 64  # GLONASS NMEA uses 1-24
                elif const_prefix == "GA":
                    prn = sat.talker_prn - 200  # Galileo NMEA uses 1-36
                sat_fields.append(f"{prn:02d},{sat.elevation:02.0f},{sat.azimuth:03.0f},{sat.snr:02.0f}")

            body = f"GSV,{total_sentences},{i + 1},{total_sats}," + ",".join(sat_fields)
            sentences.append(nmea_sentence(const_prefix, body))

    return sentences


def build_rmc(lat: float, lon: float, speed_knots: float = 0.0,
              heading: float = 0.0) -> str:
    """RMC — Recommended minimum."""
    lat_str, ns = fmt_lat(lat)
    lon_str, ew = fmt_lon(lon)
    body = (
        f"RMC,{utc_time()}.00,A,"
        f"{lat_str},{ns},{lon_str},{ew},"
        f"{speed_knots:.1f},{heading:.1f},"
        f"{utc_date()},,,A"
    )
    return nmea_sentence("GP", body)


def build_vtg(speed_knots: float = 0.0, heading: float = 0.0) -> str:
    """VTG — Track made good and ground speed."""
    body = f"VTG,{heading:.1f},T,,M,{speed_knots:.1f},N,{speed_knots * 1.852:.1f},K,A"
    return nmea_sentence("GP", body)


def build_gll(lat: float, lon: float) -> str:
    """GLL — Geographic position."""
    lat_str, ns = fmt_lat(lat)
    lon_str, ew = fmt_lon(lon)
    body = f"GLL,{lat_str},{ns},{lon_str},{ew},{utc_time()}.00,A,A"
    return nmea_sentence("GP", body)


def build_full_nmea(lat: float, lon: float, alt: float,
                    sats: list[Satellite], active: list[Satellite],
                    hdop: float = 0.4, vdop: float = 0.6) -> list[str]:
    """Build a complete NMEA burst for one epoch."""
    sentences = []

    # GSV first (satellites in view)
    sentences.extend(build_gsv(sats))

    # GSA (active satellites + DOP)
    sentences.extend(build_gsa(active, hdop, vdop))

    # GGA (fix data — RTK quality 4)
    sentences.append(build_gga(lat, lon, alt, quality=4,
                               sats_used=len(active), hdop=hdop))

    # RMC
    sentences.append(build_rmc(lat, lon))

    # VTG
    sentences.append(build_vtg())

    # GLL
    sentences.append(build_gll(lat, lon))

    return sentences


# ─── Location injection ───────────────────────────────────────────────────

def inject_location(lat: float, lon: float, alt: float,
                    accuracy: float = 0.02):
    """Inject via Android `cmd location` test provider."""
    adb([
        "shell", "cmd", "location", "providers",
        "set-test-provider-location", "gps",
        "--location", f"{lat},{lon}",
        "--accuracy", str(accuracy),
    ])


def write_nmea_to_file(sentences: list[str], filepath: str):
    """Write NMEA sentences to a file or serial port."""
    try:
        with open(filepath, "a") as f:
            for s in sentences:
                f.write(s + "\r\n")
    except Exception as e:
        print(f"NMEA file write error: {e}", file=sys.stderr)


# ─── Main simulation loop ─────────────────────────────────────────────────

def simulate_rtk(lat: float, lon: float, alt: float,
                 duration: float, interval: float, jitter: bool,
                 nmea_file: str | None = None):
    """
    Continuously inject RTK-grade locations with full satellite constellation.
    Generates realistic NMEA stream and injects location via test provider.
    """
    # Generate satellite constellation
    sats = generate_constellation(seed=int(time.time()))
    active = select_active_satellites(sats, count=12)

    print(f"Starting RTK mock GPS injection:")
    print(f"  Location: {lat}, {lon} (Drohobych, Ukraine)")
    print(f"  Altitude: {alt}m")
    print(f"  Accuracy: 0.02m (RTK fixed, quality=4)")
    print(f"  Satellites in view: {len(sats)} (GPS+GLONASS+Galileo)")
    print(f"  Satellites used: {len(active)}")
    print(f"  HDOP: 0.4, VDOP: 0.6 (RTK-grade)")
    print(f"  Duration: {duration}s, interval: {interval}s")
    print(f"  Jitter: {'ON (±2cm RTK drift)' if jitter else 'OFF'}")
    if nmea_file:
        print(f"  NMEA log: {nmea_file}")
    print(f"  Press Ctrl+C to stop.\n")

    start = time.time()
    cur_lat, cur_lon, cur_alt = lat, lon, alt
    tick = 0

    try:
        while time.time() - start < duration:
            if jitter:
                cur_lat += random.gauss(0, 0.0000002)   # ~2cm lat drift
                cur_lon += random.gauss(0, 0.0000002)   # ~2cm lon drift
                cur_alt += random.gauss(0, 0.05)         # ~5cm alt drift

            # Update satellite SNRs (slow atmospheric simulation)
            update_satellite_snr(sats, tick)
            active = select_active_satellites(sats, count=12)

            # Build full NMEA burst
            hdop = 0.4 + random.gauss(0, 0.05)
            vdop = 0.6 + random.gauss(0, 0.05)
            nmea_burst = build_full_nmea(cur_lat, cur_lon, cur_alt,
                                         sats, active, hdop, vdop)

            # Write NMEA to file if requested
            if nmea_file:
                write_nmea_to_file(nmea_burst, nmea_file)

            # Inject location via test provider
            inject_location(cur_lat, cur_lon, cur_alt, accuracy=0.02)

            tick += 1
            elapsed = time.time() - start
            print(f"\r[{elapsed:6.1f}s] tick={tick} "
                  f"lat={cur_lat:.8f} lon={cur_lon:.8f} "
                  f"alt={cur_alt:.3f} "
                  f"sats={len(active)} "
                  f"hdop={hdop:.2f} "
                  f"acc=0.02m RTK", end="", flush=True)

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\n\nStopped by user.")
    else:
        print(f"\n\nCompleted {tick} ticks over {duration}s.")
    finally:
        cleanup_test_provider()


# ─── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="RTK Mock GPS Injector — full satellite constellation simulation via USB/ADB"
    )
    parser.add_argument("--lat", type=float, default=49.3635546,
                        help="Base latitude (default: 49.3635546 — Drohobych)")
    parser.add_argument("--lon", type=float, default=23.4890859,
                        help="Base longitude (default: 23.4890859 — Drohobych)")
    parser.add_argument("--alt", type=float, default=300.0,
                        help="Base altitude in meters (default: 300.0 — Drohobych elevation)")
    parser.add_argument("--duration", type=float, default=120.0,
                        help="Duration in seconds (default: 120)")
    parser.add_argument("--interval", type=float, default=1.0,
                        help="Injection interval in seconds (default: 1.0)")
    parser.add_argument("--jitter", action="store_true",
                        help="Add realistic RTK drift jitter (±2cm)")
    parser.add_argument("--nmea-file", type=str, default=None,
                        help="Write NMEA stream to file or serial port (e.g. /dev/tty.usbserial)")
    parser.add_argument("--quality", type=int, default=4, choices=[1, 2, 4, 5],
                        help="NMEA fix quality: 1=GPS, 2=DGPS, 4=RTK fixed, 5=RTK float")

    args = parser.parse_args()

    check_device()
    setup_test_provider()
    simulate_rtk(args.lat, args.lon, args.alt,
                 args.duration, args.interval, args.jitter,
                 args.nmea_file)


if __name__ == "__main__":
    main()
