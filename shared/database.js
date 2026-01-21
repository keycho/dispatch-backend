// ============================================
// DISPATCH - SHARED DATABASE MODULE
// ============================================

import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function initPool() {
  if (pool) return pool;
  
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('[DATABASE] PostgreSQL connection configured');
  } else {
    console.log('[DATABASE] No DATABASE_URL - running without persistent storage');
  }
  
  return pool;
}

export function getPool() {
  return pool;
}

// ============================================
// DATABASE INITIALIZATION
// ============================================

export async function initDatabase() {
  if (!pool) return;
  
  try {
    await pool.query(`
      -- Scanner Incidents
      CREATE TABLE IF NOT EXISTS incidents_db (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        incident_type VARCHAR(100),
        location TEXT,
        borough VARCHAR(100),
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        priority VARCHAR(20),
        summary TEXT,
        transcript TEXT,
        units TEXT[],
        source VARCHAR(100),
        audio_url TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_city ON incidents_db(city);
      CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents_db(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_borough ON incidents_db(borough);

      -- Arrests (NYC Open Data)
      CREATE TABLE IF NOT EXISTS arrests (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        arrest_date DATE,
        offense_description TEXT,
        offense_category VARCHAR(100),
        law_category VARCHAR(50),
        borough VARCHAR(100),
        precinct VARCHAR(20),
        age_group VARCHAR(20),
        sex VARCHAR(10),
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_arrests_city ON arrests(city);
      CREATE INDEX IF NOT EXISTS idx_arrests_date ON arrests(arrest_date DESC);

      -- 911 Calls (NYC 311/911)
      CREATE TABLE IF NOT EXISTS calls_911 (
        id SERIAL PRIMARY KEY,
        external_id TEXT,
        city TEXT NOT NULL DEFAULT 'nyc',
        created_date TIMESTAMP,
        closed_date TIMESTAMP,
        agency TEXT,
        incident_type TEXT,
        descriptor TEXT,
        location_type TEXT,
        address TEXT,
        borough TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        source TEXT DEFAULT 'nyc_311_911',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calls_911_city ON calls_911(city);
      CREATE INDEX IF NOT EXISTS idx_calls_911_date ON calls_911(created_date DESC);
      CREATE INDEX IF NOT EXISTS idx_calls_911_type ON calls_911(incident_type);

      -- Inmates
      CREATE TABLE IF NOT EXISTS inmates (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        facility VARCHAR(100),
        admission_date DATE,
        status VARCHAR(50),
        top_charge TEXT,
        age INTEGER,
        sex VARCHAR(10),
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );

      -- ICE Activities
      CREATE TABLE IF NOT EXISTS ice_activities (
        id SERIAL PRIMARY KEY,
        city VARCHAR(10) NOT NULL,
        activity_type VARCHAR(50),
        location TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        description TEXT,
        agencies TEXT[],
        source VARCHAR(50),
        source_url TEXT,
        reported_by VARCHAR(50),
        verified BOOLEAN DEFAULT FALSE,
        verification_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ice_city ON ice_activities(city);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_activities(created_at DESC);

      -- Detention Facilities
      CREATE TABLE IF NOT EXISTS detention_facilities (
        id SERIAL PRIMARY KEY,
        facility_id VARCHAR(100) UNIQUE,
        name VARCHAR(200),
        city VARCHAR(10),
        state VARCHAR(10),
        address TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        facility_type VARCHAR(50),
        capacity INTEGER,
        last_updated TIMESTAMP DEFAULT NOW()
      );

      -- Address History (problem locations)
      CREATE TABLE IF NOT EXISTS address_history (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        city VARCHAR(10) NOT NULL,
        incident_count INTEGER DEFAULT 1,
        last_incident_at TIMESTAMP,
        flagged BOOLEAN DEFAULT FALSE,
        UNIQUE(address, city)
      );

      -- Community Reports
      CREATE TABLE IF NOT EXISTS community_reports (
        id SERIAL PRIMARY KEY,
        city VARCHAR(10) NOT NULL,
        report_type VARCHAR(50),
        location TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        description TEXT,
        reported_by VARCHAR(50),
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Data Sync Log
      CREATE TABLE IF NOT EXISTS data_sync_log (
        id SERIAL PRIMARY KEY,
        source VARCHAR(100),
        city VARCHAR(10),
        records_fetched INTEGER,
        records_inserted INTEGER,
        status VARCHAR(20),
        error_message TEXT,
        completed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('[DATABASE] Tables initialized');
    
    // Seed detention facilities
    await seedDetentionFacilities();
  } catch (error) {
    console.error('[DATABASE] Init error:', error.message);
  }
}

async function seedDetentionFacilities() {
  if (!pool) return;
  
  const facilities = [
    { facility_id: 'sherburne_mn', name: 'Sherburne County Jail', city: 'mpls', state: 'MN', address: '13880 Business Center Dr NW, Elk River, MN', lat: 45.3036, lng: -93.5672, facility_type: 'ice_contract', capacity: 700 },
    { facility_id: 'freeborn_mn', name: 'Freeborn County Jail', city: 'mpls', state: 'MN', address: '411 S Broadway Ave, Albert Lea, MN', lat: 43.6480, lng: -93.3683, facility_type: 'ice_contract', capacity: 104 },
    { facility_id: 'hudson_nj', name: 'Hudson County Correctional', city: 'nyc', state: 'NJ', address: '30 Hackensack Ave, Kearny, NJ', lat: 40.7618, lng: -74.1185, facility_type: 'ice_detention', capacity: 750 },
    { facility_id: 'bergen_nj', name: 'Bergen County Jail', city: 'nyc', state: 'NJ', address: '160 S River St, Hackensack, NJ', lat: 40.8826, lng: -74.0435, facility_type: 'ice_contract', capacity: 1200 }
  ];
  
  for (const f of facilities) {
    try {
      await pool.query(`
        INSERT INTO detention_facilities (facility_id, name, city, state, address, lat, lng, facility_type, capacity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (facility_id) DO NOTHING
      `, [f.facility_id, f.name, f.city, f.state, f.address, f.lat, f.lng, f.facility_type, f.capacity]);
    } catch (e) { /* ignore */ }
  }
}

// ============================================
// INCIDENT OPERATIONS
// ============================================

export async function saveIncidentToDb(incident) {
  if (!pool) return null;
  
  try {
    const result = await pool.query(`
      INSERT INTO incidents_db (external_id, city, incident_type, location, borough, lat, lng, priority, summary, transcript, units, source, audio_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (city, external_id) DO NOTHING
      RETURNING id
    `, [
      `inc_${incident.id}`, incident.city || 'nyc', incident.incidentType, incident.location,
      incident.borough, incident.lat, incident.lng, incident.priority, incident.summary,
      incident.transcript, incident.units || [], incident.source, incident.audioUrl,
      incident.timestamp || new Date()
    ]);
    
    // Update address history
    if (incident.location && incident.location !== 'Unknown') {
      await updateAddressHistory(incident.location, incident.city || 'nyc');
    }
    
    return result.rows[0]?.id;
  } catch (error) {
    console.error('[DB] Save incident error:', error.message);
    return null;
  }
}

export async function updateAddressHistory(address, city) {
  if (!pool) return;
  
  try {
    await pool.query(`
      INSERT INTO address_history (address, city, incident_count, last_incident_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (address, city) DO UPDATE SET
        incident_count = address_history.incident_count + 1,
        last_incident_at = NOW(),
        flagged = CASE WHEN address_history.incident_count >= 9 THEN TRUE ELSE address_history.flagged END
    `, [address.toLowerCase().trim(), city]);
  } catch (error) {
    console.error('[DB] Address history error:', error.message);
  }
}

// ============================================
// ARREST OPERATIONS
// ============================================

export async function saveArrestToDb(arrest, city = 'nyc') {
  if (!pool) return null;
  
  try {
    const result = await pool.query(`
      INSERT INTO arrests (external_id, city, arrest_date, offense_description, offense_category, law_category, borough, precinct, age_group, sex, lat, lng, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (city, external_id) DO NOTHING
      RETURNING id
    `, [
      arrest.arrest_key || arrest.external_id, 
      city, 
      arrest.arrest_date, 
      arrest.pd_desc || arrest.offense_description, 
      arrest.ofns_desc || arrest.offense_category, 
      arrest.law_cat_cd || arrest.law_category, 
      arrest.arrest_boro || arrest.borough, 
      arrest.arrest_precinct || arrest.precinct, 
      arrest.age_group, 
      arrest.perp_sex || arrest.sex, 
      arrest.latitude || arrest.lat, 
      arrest.longitude || arrest.lng, 
      arrest.source || 'nyc_open_data'
    ]);
    return result.rows[0]?.id;
  } catch (error) {
    return null;
  }
}

export async function saveScannerArrest(incident, cityId) {
  if (!pool) return;
  
  try {
    await pool.query(`
      INSERT INTO arrests (external_id, city, arrest_date, offense_description, offense_category, borough, lat, lng, source)
      VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, 'scanner')
    `, [
      `scanner_${Date.now()}`,
      cityId,
      incident.incidentType,
      incident.arrestType || 'unknown',
      incident.borough,
      incident.lat,
      incident.lng
    ]);
  } catch (e) { /* skip dupes */ }
}

// ============================================
// 911 CALLS OPERATIONS
// ============================================

export async function save911CallToDb(call) {
  if (!pool) return null;
  
  try {
    const result = await pool.query(`
      INSERT INTO calls_911 (external_id, city, created_date, closed_date, agency, incident_type, descriptor, location_type, address, borough, lat, lng, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (city, external_id) DO NOTHING
      RETURNING id
    `, [
      call.unique_key, 
      'nyc', 
      call.created_date, 
      call.closed_date,
      call.agency_name || 'NYPD',
      call.complaint_type,
      call.descriptor,
      call.location_type,
      call.incident_address,
      call.borough,
      call.latitude,
      call.longitude,
      'nyc_311_911'
    ]);
    return result.rows[0]?.id;
  } catch (e) {
    return null;
  }
}

// ============================================
// INMATE OPERATIONS
// ============================================

export async function saveInmateToDb(inmate) {
  if (!pool) return null;
  
  try {
    const result = await pool.query(`
      INSERT INTO inmates (external_id, city, facility, admission_date, status, top_charge, age, sex, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (city, external_id) DO NOTHING
      RETURNING id
    `, [inmate.inmateid, 'nyc', inmate.custody_level || 'Unknown', inmate.admitted_dt, 'in_custody', inmate.top_charge, inmate.age, inmate.gender, 'nyc_doc']);
    return result.rows[0]?.id;
  } catch (e) {
    return null;
  }
}

// ============================================
// SYNC LOG
// ============================================

export async function logDataSync(source, city, recordsFetched, recordsInserted, status, errorMessage = null) {
  if (!pool) return;
  
  try {
    await pool.query(
      'INSERT INTO data_sync_log (source, city, records_fetched, records_inserted, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
      [source, city, recordsFetched, recordsInserted, status, errorMessage]
    );
  } catch (e) {
    console.error('[DB] Sync log error:', e.message);
  }
}

// ============================================
// QUERY HELPERS
// ============================================

export async function getRecentIncidents(city, limit = 50) {
  if (!pool) return [];
  
  try {
    const result = await pool.query(
      'SELECT * FROM incidents_db WHERE city = $1 ORDER BY created_at DESC LIMIT $2',
      [city, limit]
    );
    return result.rows;
  } catch (e) {
    return [];
  }
}

export async function getRecentArrests(city, days = 30, limit = 100) {
  if (!pool) return [];
  
  try {
    const result = await pool.query(
      `SELECT * FROM arrests WHERE city = $1 AND arrest_date >= NOW() - INTERVAL '${days} days' ORDER BY arrest_date DESC LIMIT $2`,
      [city, limit]
    );
    return result.rows;
  } catch (e) {
    return [];
  }
}

export async function getAddressHistory(city, limit = 50) {
  if (!pool) return [];
  
  try {
    const result = await pool.query(
      'SELECT * FROM address_history WHERE city = $1 ORDER BY incident_count DESC LIMIT $2',
      [city, limit]
    );
    return result.rows;
  } catch (e) {
    return [];
  }
}

export async function getFlaggedAddresses(city) {
  if (!pool) return [];
  
  try {
    const result = await pool.query(
      'SELECT * FROM address_history WHERE city = $1 AND flagged = TRUE ORDER BY incident_count DESC',
      [city]
    );
    return result.rows;
  } catch (e) {
    return [];
  }
}
