// ============================================
// DISPATCH - SHARED CONSTANTS
// ============================================

export const CITIES = {
  nyc: {
    id: 'nyc',
    name: 'New York City',
    shortName: 'NYC',
    state: 'NY',
    mapCenter: { lat: 40.7128, lng: -74.0060 },
    mapZoom: 11,
    openmhz: { system: 'nypd', name: 'NYPD' },
    cameraApi: 'https://webcams.nyctmc.org/api/cameras',
    districts: ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'],
    landmarks: [
      'Times Square', 'Penn Station', 'Grand Central', 'Port Authority', 'Lincoln Tunnel',
      'Holland Tunnel', 'Brooklyn Bridge', 'Manhattan Bridge', 'Williamsburg Bridge',
      'Central Park', 'Prospect Park', 'Harlem', 'SoHo', 'Tribeca', 'Chinatown',
    ],
    color: '#FF6B35',
  },
  mpls: {
    id: 'mpls',
    name: 'Minneapolis',
    shortName: 'MPLS', 
    state: 'MN',
    mapCenter: { lat: 44.9778, lng: -93.2650 },
    mapZoom: 12,
    openmhz: { system: 'mnhennco', name: 'Hennepin County' },
    cameraApi: 'https://511mn.org/api/getcameras',
    districts: ['Downtown', 'North', 'Northeast', 'Southeast', 'South', 'Southwest', 'Calhoun-Isles', 'Camden', 'Near North', 'Phillips', 'Powderhorn', 'Nokomis', 'Longfellow'],
    landmarks: [
      'Target Center', 'US Bank Stadium', 'Mall of America', 'Minneapolis Convention Center',
      'Hennepin Avenue', 'Lake Street', 'Nicollet Mall', 'Stone Arch Bridge',
      'University of Minnesota', 'Minneapolis-Saint Paul Airport', 'Lake Calhoun', 'Lake Harriet',
    ],
    color: '#4ECDC4',
  }
};

// ============================================
// BROADCASTIFY FEEDS
// ============================================

export const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1', city: 'nyc' },
  { id: '40185', name: 'NYPD Citywide 2', city: 'nyc' },
  { id: '40186', name: 'NYPD Citywide 3', city: 'nyc' },
  { id: '1189', name: 'NYPD SOD/ESU/Transit', city: 'nyc' }, // Special Operations Division - reliable
  { id: '36687', name: 'NYPD Manhattan 1/5/7', city: 'nyc' },
];

// Minneapolis police is encrypted on ARMER - these are Fire/EMS and Sheriff only
export const MPLS_FEEDS = [
  // { id: '13544', name: 'Minneapolis Police', city: 'mpls' }, // Likely encrypted/offline
  { id: '26049', name: 'Hennepin County Sheriff', city: 'mpls' },
  { id: '30435', name: 'Hennepin County Fire/EMS', city: 'mpls' },
  { id: '741', name: 'Minneapolis Fire', city: 'mpls' },
];

export const ALL_FEEDS = [...NYPD_FEEDS, ...MPLS_FEEDS];

// ============================================
// OPENMHZ SYSTEMS
// ============================================

export const OPENMHZ_SYSTEMS = {
  nyc: { system: 'nypd', name: 'NYPD' },
  mpls: { system: 'mnhennco', name: 'Hennepin County' }
};

export const OPENMHZ_POLL_INTERVAL = 10000; // 10 seconds

// ============================================
// BROADCASTIFY CALLS API
// ============================================

export const BCFY_API_URL = 'https://api.bcfy.io';
export const NYC_COUNTY_ID = 1855; // NYC County ID in RadioReference database
export const HENNEPIN_COUNTY_ID = 1336; // Hennepin County (Minneapolis) - Note: Police is encrypted, mostly fire/EMS available
export const BCFY_POLL_INTERVAL = 30000; // 30 seconds - archives have 15min delay anyway

// ============================================
// NYPD PRECINCT TO BOROUGH MAPPING
// ============================================

export const PRECINCT_TO_BOROUGH = {
  // Manhattan (1-34)
  '1': 'Manhattan', '5': 'Manhattan', '6': 'Manhattan', '7': 'Manhattan', '9': 'Manhattan',
  '10': 'Manhattan', '13': 'Manhattan', '14': 'Manhattan', '17': 'Manhattan', '18': 'Manhattan',
  '19': 'Manhattan', '20': 'Manhattan', '22': 'Manhattan', '23': 'Manhattan', '24': 'Manhattan',
  '25': 'Manhattan', '26': 'Manhattan', '28': 'Manhattan', '30': 'Manhattan', '32': 'Manhattan',
  '33': 'Manhattan', '34': 'Manhattan',
  // Bronx (40-52)
  '40': 'Bronx', '41': 'Bronx', '42': 'Bronx', '43': 'Bronx', '44': 'Bronx',
  '45': 'Bronx', '46': 'Bronx', '47': 'Bronx', '48': 'Bronx', '49': 'Bronx',
  '50': 'Bronx', '52': 'Bronx',
  // Brooklyn (60-94)
  '60': 'Brooklyn', '61': 'Brooklyn', '62': 'Brooklyn', '63': 'Brooklyn', '66': 'Brooklyn',
  '67': 'Brooklyn', '68': 'Brooklyn', '69': 'Brooklyn', '70': 'Brooklyn', '71': 'Brooklyn',
  '72': 'Brooklyn', '73': 'Brooklyn', '75': 'Brooklyn', '76': 'Brooklyn', '77': 'Brooklyn',
  '78': 'Brooklyn', '79': 'Brooklyn', '81': 'Brooklyn', '83': 'Brooklyn', '84': 'Brooklyn',
  '88': 'Brooklyn', '90': 'Brooklyn', '94': 'Brooklyn',
  // Queens (100-115)
  '100': 'Queens', '101': 'Queens', '102': 'Queens', '103': 'Queens', '104': 'Queens',
  '105': 'Queens', '106': 'Queens', '107': 'Queens', '108': 'Queens', '109': 'Queens',
  '110': 'Queens', '111': 'Queens', '112': 'Queens', '113': 'Queens', '114': 'Queens', '115': 'Queens',
  // Staten Island (120-123)
  '120': 'Staten Island', '121': 'Staten Island', '122': 'Staten Island', '123': 'Staten Island'
};

export function getPrecinctBorough(precinctNum) {
  const num = precinctNum.toString().replace(/\D/g, '');
  return PRECINCT_TO_BOROUGH[num] || null;
}

// ============================================
// NYC LANDMARKS
// ============================================

export const NYC_LANDMARKS = [
  'Times Square', 'Penn Station', 'Grand Central', 'Port Authority', 'Lincoln Tunnel',
  'Holland Tunnel', 'Brooklyn Bridge', 'Manhattan Bridge', 'Williamsburg Bridge',
  'GW Bridge', 'George Washington Bridge', 'Yankee Stadium', 'Citi Field', 'JFK', 'LaGuardia',
  'Central Park', 'Prospect Park', 'Harlem', 'SoHo', 'Tribeca', 'Chinatown', 'Little Italy',
  'East Village', 'West Village', 'Midtown', 'Downtown', 'Uptown', 'FDR', 'West Side Highway',
  'BQE', 'LIE', 'Cross Bronx', 'Major Deegan', 'Bruckner', 'Flatbush', 'Atlantic Avenue',
  'Fulton Street', 'Broadway', '125th Street', '42nd Street', '34th Street', '14th Street',
  'Wall Street', 'Canal Street', 'Houston Street', 'Delancey', 'Bowery'
];

// ============================================
// PROCESSING CONSTANTS
// ============================================

export const CHUNK_DURATION = 15000; // 15 seconds for audio chunks
export const MAX_CONCURRENT_STREAMS = 4;
export const MAX_TRANSCRIPTS = 20;
export const MAX_AUDIO_CLIPS = 50;
export const MAX_PROCESSED_CACHE = 1000;

// ============================================
// REDIS CHANNELS
// ============================================

export const REDIS_CHANNELS = {
  INCIDENTS: 'dispatch:incidents',
  TRANSCRIPTS: 'dispatch:transcripts',
  CAMERAS: 'dispatch:cameras',
  AGENT_INSIGHTS: 'dispatch:agent_insights',
  PREDICTIONS: 'dispatch:predictions',
  ICE_ALERTS: 'dispatch:ice_alerts',
  BETS: 'dispatch:bets',
  ACTIVITY: 'dispatch:activity',
  WORKER_STATUS: 'dispatch:worker_status'
};

// ============================================
// GAMIFICATION
// ============================================

export const HOUSE_EDGE = 0.08;
export const SIGNUP_BONUS = 500;
export const DAILY_LOGIN_BONUS = 50;
export const MIN_PREDICTION = 10;
export const MAX_PREDICTION = 10000;

export const RANKS = [
  { minPts: 0, rank: 'Rookie', icon: '👤', color: '#6b7280' },
  { minPts: 500, rank: 'Beat Cop', icon: '👮', color: '#3b82f6' },
  { minPts: 2000, rank: 'Detective', icon: '🔍', color: '#8b5cf6' },
  { minPts: 5000, rank: 'Sergeant', icon: '⭐', color: '#f59e0b' },
  { minPts: 10000, rank: 'Lieutenant', icon: '🎖️', color: '#ef4444' },
  { minPts: 25000, rank: 'Captain', icon: '🏅', color: '#ec4899' },
  { minPts: 50000, rank: 'Commander', icon: '👑', color: '#f97316' },
  { minPts: 100000, rank: 'Commissioner', icon: '🏆', color: '#ffd700' }
];

export const STREAK_BONUSES = {
  login: [
    { days: 1, bonus: 50, label: 'Daily' },
    { days: 3, bonus: 75, label: '3-Day Streak' },
    { days: 7, bonus: 150, label: 'Week Warrior' },
    { days: 14, bonus: 300, label: 'Dedicated' },
    { days: 30, bonus: 500, label: 'Monthly Master' }
  ],
  prediction: [
    { streak: 2, multiplier: 1.1, label: 'Double Down' },
    { streak: 3, multiplier: 1.25, label: 'Hot Streak' },
    { streak: 5, multiplier: 1.5, label: 'On Fire' },
    { streak: 10, multiplier: 2.0, label: 'Unstoppable' }
  ]
};

// ============================================
// FILTERING PATTERNS
// ============================================

export const NOISE_PATTERNS = ['thank you', 'thanks for watching', 'subscribe', 'you', 'bye', 'music', 'you.', 'bye.'];

export const PROMPT_LEAKAGE_PATTERNS = [
  'addresses like', 'intersections like', 'landmarks like', 
  'nypd police radio dispatch',
  '10-4, 10-13, 10-85',
  'forthwith, precinct, sector, central',
  'k, forthwith, precinct',
  '42nd and lex', 'times square, penn station'
];

export const SIGN_OFF_PATTERNS = [
  'have a good night', 'have a good evening', 'have a good one',
  'good night', 'good evening', 'see you', 'take care',
  '10-4', '10-7', '10-8', '10-41', '10-42',
  'copy that', 'roger', 'affirmative',
  'going off duty', 'end of shift', 'signing off',
  'every night', 'every evening'
];

export const GARBAGE_PATTERNS = [
  'un.org', 'un videos', 'united nations',
  'test broadcast', 'this is a test',
  'lorem ipsum', 'placeholder',
  'stream offline', 'feed offline',
  'no audio', 'audio unavailable'
];
