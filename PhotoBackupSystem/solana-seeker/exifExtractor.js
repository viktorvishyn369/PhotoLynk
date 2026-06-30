/**
 * EXIF Extractor for cross-platform HEIC deduplication and universal EXIF preservation
 * Extracts real EXIF metadata from image files for:
 * 1. Deduplication (captureTime, make, model)
 * 2. Universal preservation (ALL EXIF fields stored on server by file hash)
 */

import { Platform, NativeModules } from 'react-native';
import * as Device from 'expo-device';
import { sha256 } from 'js-sha256';

const { ExifExtractor } = NativeModules;

/**
 * Normalize GPS coordinate to decimal degrees
 * Handles various formats: decimal, DMS array, DMS string
 * @param {number|Array|string} coord - GPS coordinate in various formats
 * @param {string} ref - Reference direction (N/S for lat, E/W for lon)
 * @returns {number|null} Decimal degrees (negative for S/W)
 */
/**
 * Safely convert a string to ASCII-safe format for EXIF compatibility
 * EXIF Make/Model fields only support ASCII per spec
 * @param {string} str - Input string (may contain Unicode)
 * @returns {string} ASCII-safe string
 */
function toAsciiSafe(str) {
  if (!str || typeof str !== 'string') return str;
  // Keep original if already ASCII
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  // Try to transliterate common characters, otherwise keep original
  // Most camera manufacturers use ASCII names anyway
  return str;
}

/**
 * Safely handle string that may have encoding issues
 * Detects and handles UTF-8, Latin-1, and other encodings
 * @param {any} value - Input value
 * @returns {string|null} Cleaned string or null
 */
function safeString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    // Handle byte arrays that might be strings
    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      try {
        // Try UTF-8 decoding
        const bytes = new Uint8Array(value);
        const decoder = new TextDecoder('utf-8', { fatal: false });
        return decoder.decode(bytes).replace(/\0/g, '').trim();
      } catch (e) {
        return null;
      }
    }
    return String(value);
  }
  // Clean null bytes and trim
  return value.replace(/\0/g, '').trim();
}

function normalizeGpsCoordinate(coord, ref) {
  if (coord == null) return null;
  
  let decimal = null;
  
  // Already decimal
  if (typeof coord === 'number') {
    decimal = coord;
  }
  // DMS array format: [degrees, minutes, seconds] or [[d,1], [m,1], [s,100]]
  else if (Array.isArray(coord)) {
    if (coord.length >= 3) {
      // Handle rational format [[d,1], [m,1], [s,100]]
      const d = Array.isArray(coord[0]) ? coord[0][0] / coord[0][1] : coord[0];
      const m = Array.isArray(coord[1]) ? coord[1][0] / coord[1][1] : coord[1];
      const s = Array.isArray(coord[2]) ? coord[2][0] / coord[2][1] : coord[2];
      decimal = d + m / 60 + s / 3600;
    } else if (coord.length === 1) {
      decimal = Array.isArray(coord[0]) ? coord[0][0] / coord[0][1] : coord[0];
    }
  }
  // String format: "40/1,26/1,46/1" or "40.446195"
  else if (typeof coord === 'string') {
    const parts = coord.split(',');
    if (parts.length >= 3) {
      // DMS rational string format
      const parseRational = (s) => {
        const [num, den] = s.trim().split('/').map(Number);
        return den ? num / den : num;
      };
      const d = parseRational(parts[0]);
      const m = parseRational(parts[1]);
      const s = parseRational(parts[2]);
      decimal = d + m / 60 + s / 3600;
    } else {
      decimal = parseFloat(coord);
    }
  }
  
  if (decimal == null || isNaN(decimal)) return null;
  
  // Apply direction reference (S and W are negative)
  if (ref === 'S' || ref === 'W') {
    decimal = -Math.abs(decimal);
  }
  
  return decimal;
}

/**
 * Extract FULL EXIF data from assetInfo for server storage
 * This captures ALL available EXIF fields for universal cross-platform preservation
 * @param {Object} assetInfo - expo-media-library AssetInfo with exif property
 * @param {Object} asset - expo-media-library Asset with creationTime, location, etc.
 * @returns {Object} Full EXIF data object with all available fields
 */
export function extractFullExif(assetInfo, asset) {
  const result = {
    // Core identification
    captureTime: null,
    make: null,
    model: null,
    // Timezone/subsecond precision (critical for cross-platform sorting)
    offsetTimeOriginal: null,  // e.g., "+02:00" or "-05:00"
    subSecTimeOriginal: null,  // milliseconds as string, e.g., "123"
    // Camera settings
    exposureTime: null,
    fNumber: null,
    iso: null,
    focalLength: null,
    focalLengthIn35mm: null,
    flash: null,
    whiteBalance: null,
    meteringMode: null,
    exposureProgram: null,
    exposureBias: null,
    // Image properties
    width: null,
    height: null,
    orientation: null,
    colorSpace: null,
    // GPS/Location (always stored as decimal degrees for cross-platform compatibility)
    gpsLatitude: null,
    gpsLongitude: null,
    gpsAltitude: null,
    gpsTimestamp: null,
    gpsDateStamp: null,  // GPS date in "YYYY:MM:DD" format
    // Software/processing
    software: null,
    lensMake: null,
    lensModel: null,
    // IPTC fields (professional metadata)
    iptcCaption: null, iptcCopyright: null, iptcKeywords: null,
    iptcCreator: null, iptcTitle: null, iptcCity: null,
    iptcCountry: null, iptcCredit: null, iptcSource: null,
    // XMP fields (Lightroom/editing metadata)
    xmpRating: null, xmpLabel: null, xmpSubject: null,
    xmpCreatorTool: null, xmpRights: null, xmpDescription: null,
    // MakerNote hash (proprietary camera data)
    makerNoteHash: null,
    // ICC color profile name
    iccProfileName: null,
    // Raw EXIF object for any fields we might miss
    rawExif: null,
  };

  try {
    const rawExifObj = assetInfo?.exif;
    
    // iOS CGImageSource returns EXIF nested under {Exif}, {GPS}, {TIFF} sub-dicts
    // Android ExifInterface returns flat keys. Merge both into a single flat object.
    const exif = {};
    if (rawExifObj && typeof rawExifObj === 'object') {
      // First copy top-level keys
      for (const [k, v] of Object.entries(rawExifObj)) {
        if (k === '{Exif}' || k === '{GPS}' || k === '{TIFF}' || k === '{MakerApple}') continue;
        exif[k] = v;
      }
      // Then merge nested iOS dicts (these take priority for EXIF-specific fields)
      if (rawExifObj['{TIFF}'] && typeof rawExifObj['{TIFF}'] === 'object') {
        for (const [k, v] of Object.entries(rawExifObj['{TIFF}'])) {
          if (exif[k] == null) exif[k] = v;
        }
      }
      if (rawExifObj['{Exif}'] && typeof rawExifObj['{Exif}'] === 'object') {
        for (const [k, v] of Object.entries(rawExifObj['{Exif}'])) {
          exif[k] = v; // Exif IFD fields override TIFF IFD
        }
      }
      // Flatten iOS {IPTC} dict
      if (rawExifObj['{IPTC}'] && typeof rawExifObj['{IPTC}'] === 'object') {
        for (const [k, v] of Object.entries(rawExifObj['{IPTC}'])) {
          if (exif['IPTC_' + k] == null) exif['IPTC_' + k] = v;
        }
      }
      if (rawExifObj['{GPS}'] && typeof rawExifObj['{GPS}'] === 'object') {
        const gps = rawExifObj['{GPS}'];
        // Map iOS GPS keys to standard EXIF GPS keys
        if (gps.Latitude != null) exif.GPSLatitude = gps.Latitude;
        if (gps.Longitude != null) exif.GPSLongitude = gps.Longitude;
        if (gps.Altitude != null) exif.GPSAltitude = gps.Altitude;
        if (gps.LatitudeRef) exif.GPSLatitudeRef = gps.LatitudeRef;
        if (gps.LongitudeRef) exif.GPSLongitudeRef = gps.LongitudeRef;
        if (gps.AltitudeRef != null) exif.GPSAltitudeRef = gps.AltitudeRef;
        if (gps.TimeStamp) exif.GPSTimeStamp = gps.TimeStamp;
        if (gps.DateStamp) exif.GPSDateStamp = gps.DateStamp;
        if (gps.Speed != null) exif.GPSSpeed = gps.Speed;
        if (gps.ImgDirection != null) exif.GPSImgDirection = gps.ImgDirection;
      }
    }
    
    // Core identification
    let captureTimeStr = exif?.DateTimeOriginal || exif?.DateTimeDigitized || exif?.DateTime;
    if (captureTimeStr && typeof captureTimeStr === 'string') {
      const normalized = captureTimeStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)) {
        result.captureTime = normalized.slice(0, 19);
      }
    }
    
    // Fallback to asset.creationTime
    if (!result.captureTime && asset?.creationTime) {
      const d = new Date(asset.creationTime);
      if (!isNaN(d.getTime())) {
        result.captureTime = d.toISOString().slice(0, 19);
      }
    }

    // Device info - use safeString to handle encoding issues (Japanese/Chinese cameras)
    if (exif?.Make) result.make = safeString(exif.Make);
    if (exif?.Model) result.model = safeString(exif.Model);
    
    // Fallback to device info for formats without EXIF (PNG screenshots, etc.)
    // iOS Camera app also doesn't embed Make/Model in photos (privacy feature)
    if (!result.make) {
      if (Platform.OS === 'ios') {
        result.make = 'apple';
      } else if (Device.manufacturer) {
        result.make = Device.manufacturer.toLowerCase();
      }
    }
    if (!result.model) {
      if (Device.modelId) {
        // Device.modelId returns e.g., "iPhone15,2" for iPhone 14 Pro
        result.model = Device.modelId.toLowerCase();
      } else if (Device.modelName) {
        result.model = Device.modelName.toLowerCase();
      }
    }

    // Camera settings
    // Normalize decimals to 4dp for cross-platform consistency (r4 = round to 4dp)
    // Different EXIF libraries return slightly different float representations of the same TIFF rational
    const r4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? (Number.isInteger(n) ? n : Math.round(n * 1e4) / 1e4) : null; };
    if (exif?.ExposureTime != null) result.exposureTime = r4(exif.ExposureTime);
    if (exif?.FNumber != null) result.fNumber = r4(exif.FNumber);
    if (exif?.ISOSpeedRatings != null) result.iso = Array.isArray(exif.ISOSpeedRatings) ? exif.ISOSpeedRatings[0] : exif.ISOSpeedRatings;
    if (exif?.ISO != null) result.iso = result.iso || exif.ISO;
    if (exif?.FocalLength != null) result.focalLength = r4(exif.FocalLength);
    if (exif?.FocalLengthIn35mmFilm != null) result.focalLengthIn35mm = r4(exif.FocalLengthIn35mmFilm);
    // iOS uses FocalLenIn35mmFilm (shortened key name)
    if (result.focalLengthIn35mm == null && exif?.FocalLenIn35mmFilm != null) result.focalLengthIn35mm = r4(exif.FocalLenIn35mmFilm);
    if (exif?.Flash != null) result.flash = exif.Flash;
    if (exif?.WhiteBalance != null) result.whiteBalance = exif.WhiteBalance;
    if (exif?.MeteringMode != null) result.meteringMode = exif.MeteringMode;
    if (exif?.ExposureProgram != null) result.exposureProgram = exif.ExposureProgram;
    if (exif?.ExposureBiasValue != null) result.exposureBias = r4(exif.ExposureBiasValue);

    // Image properties
    if (exif?.PixelXDimension != null) result.width = exif.PixelXDimension;
    if (exif?.PixelYDimension != null) result.height = exif.PixelYDimension;
    if (exif?.ImageWidth != null) result.width = result.width || exif.ImageWidth;
    if (exif?.ImageLength != null) result.height = result.height || exif.ImageLength;
    if (exif?.Orientation != null) result.orientation = exif.Orientation;
    if (exif?.ColorSpace != null) result.colorSpace = exif.ColorSpace;

    // Timezone offset (EXIF 2.31+) - critical for cross-platform time sorting
    if (exif?.OffsetTimeOriginal) result.offsetTimeOriginal = String(exif.OffsetTimeOriginal).trim();
    else if (exif?.OffsetTime) result.offsetTimeOriginal = String(exif.OffsetTime).trim();
    
    // Subsecond precision
    if (exif?.SubSecTimeOriginal != null) result.subSecTimeOriginal = String(exif.SubSecTimeOriginal);
    // iOS uses SubsecTimeOriginal (lowercase 's')
    else if (exif?.SubsecTimeOriginal != null) result.subSecTimeOriginal = String(exif.SubsecTimeOriginal);
    else if (exif?.SubSecTime != null) result.subSecTimeOriginal = String(exif.SubSecTime);
    else if (exif?.SubsecTime != null) result.subSecTimeOriginal = String(exif.SubsecTime);

    // GPS/Location from EXIF - normalize to decimal degrees
    // Truncate GPS to 4dp (~11m accuracy) for cross-platform stability
    const t4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? Math.trunc(n * 1e4) / 1e4 : null; };
    if (exif?.GPSLatitude != null) {
      // Handle both decimal and DMS formats
      const lat = normalizeGpsCoordinate(exif.GPSLatitude, exif.GPSLatitudeRef);
      result.gpsLatitude = lat != null ? t4(lat) : null;
    }
    if (exif?.GPSLongitude != null) {
      const lon = normalizeGpsCoordinate(exif.GPSLongitude, exif.GPSLongitudeRef);
      result.gpsLongitude = lon != null ? t4(lon) : null;
    }
    if (exif?.GPSAltitude != null) {
      let alt = typeof exif.GPSAltitude === 'number' ? exif.GPSAltitude : parseFloat(exif.GPSAltitude);
      // Apply altitude ref (0 = above sea level, 1 = below)
      if (exif?.GPSAltitudeRef === 1 && alt > 0) {
        alt = -alt;
      }
      result.gpsAltitude = t4(alt);
    }
    if (exif?.GPSTimeStamp != null) result.gpsTimestamp = exif.GPSTimeStamp;
    if (exif?.GPSDateStamp != null) result.gpsDateStamp = exif.GPSDateStamp;
    
    // Fallback to asset location
    if (asset?.location) {
      if (result.gpsLatitude == null && asset.location.latitude != null) {
        result.gpsLatitude = asset.location.latitude;
      }
      if (result.gpsLongitude == null && asset.location.longitude != null) {
        result.gpsLongitude = asset.location.longitude;
      }
    }

    // Software/lens info - use safeString for international character support
    if (exif?.Software) result.software = safeString(exif.Software);
    if (exif?.LensMake) result.lensMake = safeString(exif.LensMake);
    if (exif?.LensModel) result.lensModel = safeString(exif.LensModel);

    // IPTC fields — from iOS {IPTC} dict or Android flat keys
    if (exif?.IPTC_Caption || exif?.['Caption/Abstract'] || exif?.ImageDescription) {
      result.iptcCaption = safeString(exif.IPTC_Caption || exif['Caption/Abstract'] || exif.ImageDescription);
    }
    if (exif?.IPTC_CopyrightNotice || exif?.Copyright) {
      result.iptcCopyright = safeString(exif.IPTC_CopyrightNotice || exif.Copyright);
    }
    if (exif?.IPTC_Keywords) {
      const kw = exif.IPTC_Keywords;
      result.iptcKeywords = Array.isArray(kw) ? kw : (typeof kw === 'string' ? kw.split(',').map(s => s.trim()) : null);
    }
    if (exif?.IPTC_Byline || exif?.Artist) {
      result.iptcCreator = safeString(exif.IPTC_Byline || exif.Artist);
    }
    if (exif?.IPTC_ObjectName) result.iptcTitle = safeString(exif.IPTC_ObjectName);
    if (exif?.IPTC_City) result.iptcCity = safeString(exif.IPTC_City);
    if (exif?.IPTC_Country) result.iptcCountry = safeString(exif.IPTC_Country);
    if (exif?.IPTC_Credit) result.iptcCredit = safeString(exif.IPTC_Credit);
    if (exif?.IPTC_Source) result.iptcSource = safeString(exif.IPTC_Source);

    // XMP fields — iOS may provide these at top level or in rawExif
    if (exif?.Rating != null) result.xmpRating = Number(exif.Rating);
    if (exif?.Label) result.xmpLabel = safeString(exif.Label);
    if (exif?.Subject) result.xmpSubject = safeString(exif.Subject);
    if (exif?.CreatorTool) result.xmpCreatorTool = safeString(exif.CreatorTool);
    if (exif?.Rights) result.xmpRights = safeString(exif.Rights);
    if (exif?.Description) result.xmpDescription = safeString(exif.Description);

    // ICC profile name — iOS provides this in {ColorModel} or ProfileName
    if (exif?.ProfileName) result.iccProfileName = safeString(exif.ProfileName);
    else if (exif?.ColorModel) result.iccProfileName = safeString(exif.ColorModel);

    // MakerNote hash — iOS {MakerApple} dict
    if (rawExifObj?.['{MakerApple}'] && typeof rawExifObj['{MakerApple}'] === 'object') {
      try {
        const mnJson = JSON.stringify(rawExifObj['{MakerApple}']);
        result.makerNoteHash = sha256(mnJson);
      } catch (_) {}
    }

    // Store raw EXIF for any fields we might have missed
    // Filter out very large or binary fields - use original nested structure
    const rawSource = rawExifObj || exif;
    if (rawSource && typeof rawSource === 'object') {
      const rawExif = {};
      for (const [key, value] of Object.entries(rawSource)) {
        if (value == null) continue;
        if (typeof value === 'string' && value.length > 500) continue; // Skip large strings
        if (ArrayBuffer.isView(value)) continue; // Skip binary data
        rawExif[key] = value;
      }
      if (Object.keys(rawExif).length > 0) {
        result.rawExif = rawExif;
      }
    }
  } catch (e) {
    console.warn('extractFullExif error:', e?.message);
  }

  return result;
}

/**
 * Extract EXIF data from a HEIC file
 * @param {string} filePath - Path to the HEIC file
 * @returns {Promise<{captureTime: string|null, make: string|null, model: string|null}>}
 */
export async function extractExifFromHEIC(filePath) {
  if (!filePath) {
    return { captureTime: null, make: null, model: null };
  }

  if (Platform.OS === 'ios') {
    // Use native iOS module for EXIF extraction
    if (!ExifExtractor || !ExifExtractor.extractExif) {
      console.warn('ExifExtractor native module not available');
      return { captureTime: null, make: null, model: null };
    }
    
    try {
      const result = await ExifExtractor.extractExif(filePath);
      return {
        captureTime: result.captureTime || null,
        make: result.make || null,
        model: result.model || null
      };
    } catch (e) {
      console.warn('EXIF extraction failed:', e?.message);
      return { captureTime: null, make: null, model: null };
    }
  } else if (Platform.OS === 'android') {
    // Use native Android module for EXIF extraction
    if (!ExifExtractor || !ExifExtractor.extractExif) {
      console.warn('ExifExtractor native module not available on Android');
      return { captureTime: null, make: null, model: null };
    }
    
    try {
      const result = await ExifExtractor.extractExif(filePath);
      return {
        captureTime: result.captureTime || null,
        make: result.make || null,
        model: result.model || null
      };
    } catch (e) {
      console.warn('EXIF extraction failed on Android:', e?.message);
      return { captureTime: null, make: null, model: null };
    }
  }

  return { captureTime: null, make: null, model: null };
}

/**
 * Compute normalized EXIF hash from assetInfo.exif for HEIC/RAW files.
 * Falls back to this when computeExifHash (JPEG APP1 parser) returns null.
 * Flattens iOS nested {Exif}/{GPS}/{TIFF} dicts, extracts raw numeric values,
 * and produces a hash matching desktop computeExifHashFromFile (ExifReader).
 * @param {Object} assetInfo - expo-media-library AssetInfo with exif property
 * @returns {string|null} SHA256 hex hash or null
 */
export function computeExifHashFromAssetInfo(assetInfo) {
  try {
    const rawExifObj = assetInfo?.exif;
    if (!rawExifObj || typeof rawExifObj !== 'object') return null;

    // Flatten iOS nested dicts into flat object (same logic as extractFullExif)
    const exif = {};
    for (const [k, v] of Object.entries(rawExifObj)) {
      if (k === '{Exif}' || k === '{GPS}' || k === '{TIFF}' || k === '{MakerApple}') continue;
      exif[k] = v;
    }
    if (rawExifObj['{TIFF}'] && typeof rawExifObj['{TIFF}'] === 'object') {
      for (const [k, v] of Object.entries(rawExifObj['{TIFF}'])) {
        if (exif[k] == null) exif[k] = v;
      }
    }
    if (rawExifObj['{Exif}'] && typeof rawExifObj['{Exif}'] === 'object') {
      for (const [k, v] of Object.entries(rawExifObj['{Exif}'])) {
        exif[k] = v;
      }
    }
    // Map iOS GPS keys to standard keys
    if (rawExifObj['{GPS}'] && typeof rawExifObj['{GPS}'] === 'object') {
      const gps = rawExifObj['{GPS}'];
      if (gps.Latitude != null) exif.GPSLatitude = gps.Latitude;
      if (gps.Longitude != null) exif.GPSLongitude = gps.Longitude;
      if (gps.Altitude != null) exif.GPSAltitude = gps.Altitude;
      if (gps.LatitudeRef) exif.GPSLatitudeRef = gps.LatitudeRef;
      if (gps.LongitudeRef) exif.GPSLongitudeRef = gps.LongitudeRef;
    }

    // Build normalized object matching desktop computeExifHashFromFile field list
    // Round non-GPS decimals to 4dp for cross-platform stability.
    // Different EXIF libraries (ExifReader, exif-reader, iOS CGImageSource, exiftool)
    // return slightly different float representations of the same TIFF rational.
    // e.g. FNumber 178/100=1.78 vs 1244236/699009=1.7799999713... both round to 1.78.
    // Max float drift from rational re-encoding is ~1e-7; round4 boundary gap is 5e-5 (500x margin).
    // GPS uses trunc (not round) to avoid grid boundary crossing (49.99999→50 crosses a degree).
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const t4 = (v) => Math.trunc(v * 1e4) / 1e4;
    const num4 = (v) => { const n = Number(v); return Number.isInteger(n) ? n : r4(n); };
    const normalized = {};

    // IFD0
    if (exif.Make) normalized.Make = String(exif.Make).trim();
    if (exif.Model) normalized.Model = String(exif.Model).trim();
    if (exif.Orientation != null) normalized.Orientation = Number(exif.Orientation);

    // ExifIFD
    const dto = exif.DateTimeOriginal || exif.DateTimeDigitized;
    if (dto && typeof dto === 'string') normalized.DateTimeOriginal = dto.slice(0, 19);
    if (exif.ExposureTime != null) normalized.ExposureTime = num4(exif.ExposureTime);
    if (exif.FNumber != null) normalized.FNumber = num4(exif.FNumber);
    const isoVal = Array.isArray(exif.ISOSpeedRatings) ? exif.ISOSpeedRatings[0] : (exif.ISOSpeedRatings ?? exif.ISO);
    if (isoVal != null) normalized.ISO = num4(isoVal);
    if (exif.FocalLength != null) normalized.FocalLength = num4(exif.FocalLength);
    const fl35 = exif.FocalLengthIn35mmFilm ?? exif.FocalLenIn35mmFilm;
    if (fl35 != null) normalized.FocalLengthIn35mm = num4(fl35);
    if (exif.ExposureMode != null) normalized.ExposureMode = num4(exif.ExposureMode);
    if (exif.WhiteBalance != null) normalized.WhiteBalance = num4(exif.WhiteBalance);
    if (exif.MeteringMode != null) normalized.MeteringMode = num4(exif.MeteringMode);
    if (exif.Flash != null) normalized.Flash = num4(exif.Flash);
    if (exif.ColorSpace != null) normalized.ColorSpace = num4(exif.ColorSpace);
    if (exif.PixelXDimension != null) normalized.PixelXDimension = num4(exif.PixelXDimension);
    if (exif.PixelYDimension != null) normalized.PixelYDimension = num4(exif.PixelYDimension);
    if (exif.SceneCaptureType != null) normalized.SceneCaptureType = num4(exif.SceneCaptureType);
    if (exif.LensMake) normalized.LensMake = String(exif.LensMake).trim();
    if (exif.LensModel) normalized.LensModel = String(exif.LensModel).trim();
    if (exif.BodySerialNumber) normalized.BodySerialNumber = String(exif.BodySerialNumber).trim();

    // GPS — iOS provides decimal degrees directly, same 4dp truncation
    if (exif.GPSLatitude != null) {
      let lat = Number(exif.GPSLatitude);
      if (exif.GPSLatitudeRef === 'S') lat = -Math.abs(lat);
      normalized.GPSLatitude = t4(lat);
    }
    if (exif.GPSLongitude != null) {
      let lon = Number(exif.GPSLongitude);
      if (exif.GPSLongitudeRef === 'W') lon = -Math.abs(lon);
      normalized.GPSLongitude = t4(lon);
    }
    if (exif.GPSAltitude != null) normalized.GPSAltitude = t4(Number(exif.GPSAltitude));

    if (Object.keys(normalized).length === 0) {
      console.log('[NFT] EXIF hash from assetInfo: no meaningful fields');
      return null;
    }

    // Universal decimal safety net: round non-GPS numerics to 4dp, trunc GPS to 4dp.
    // This catches any numeric field (current or future) that may have cross-platform float drift.
    const GPS_KEYS = new Set(['GPSLatitude', 'GPSLongitude', 'GPSAltitude']);
    const sorted = {};
    for (const key of Object.keys(normalized).sort()) {
      let v = normalized[key];
      if (typeof v === 'number' && !Number.isInteger(v)) {
        v = GPS_KEYS.has(key) ? t4(v) : r4(v);
      }
      sorted[key] = v;
    }
    const json = JSON.stringify(sorted);
    const hash = sha256(json);
    console.log('[NFT] EXIF hash from assetInfo (' + Object.keys(sorted).length + ' fields):', hash.substring(0, 16) + '...');
    return hash;
  } catch (e) {
    console.warn('[NFT] EXIF hash from assetInfo failed:', e?.message);
    return null;
  }
}

/**
 * Normalize EXIF capture time to ISO format for consistent comparison
 * @param {string} captureTime - EXIF capture time string
 * @returns {string|null} - Normalized ISO format (YYYY-MM-DDTHH:MM:SS)
 */
export function normalizeExifCaptureTime(captureTime) {
  if (!captureTime) return null;
  
  // Already in ISO format
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(captureTime)) {
    return captureTime.slice(0, 19); // Strip milliseconds/timezone
  }
  
  // EXIF format: "YYYY:MM:DD HH:MM:SS"
  const exifMatch = captureTime.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (exifMatch) {
    const [, year, month, day, hour, min, sec] = exifMatch;
    return `${year}-${month}-${day}T${hour}:${min}:${sec}`;
  }
  
  return null;
}
