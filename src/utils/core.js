import { v4 as uuidv4 } from 'uuid';
import { localGet, localSet } from './storage';

const STATSIG_KEY_STABLE_ID = 'statsig_stable_id';

export function getSDKVersion() {
  return require('../../package.json')?.version ?? '';
}

export function getSDKType() {
  return 'statsig-js-client-sdk';
}

export function generateID() {
  return uuidv4();
}

export function getStableID() {
  let deviceID = localGet(STATSIG_KEY_STABLE_ID);
  if (deviceID) {
    return deviceID;
  }
  deviceID = generateID();
  localSet(STATSIG_KEY_STABLE_ID, deviceID);
  return deviceID;
}

export function clone(obj) {
  if (obj == null) {
    return null;
  }
  return JSON.parse(JSON.stringify(obj));
}

// Return null if num can be parsed to a number, otherwise return null
export function getNumericValue(num) {
  if (num == null) {
    return null;
  }
  const n = Number(num);
  if (typeof n === 'number' && !isNaN(n) && isFinite(n) && num != null) {
    return n;
  }
  return null;
}

// Return the boolean value of the input if it can be casted into a boolean, null otherwise
export function getBoolValue(val) {
  if (val == null) {
    return null;
  } else if (val.toString().toLowerCase() === 'true') {
    return true;
  } else if (val.toString().toLowerCase() === 'false') {
    return false;
  }
  return null;
}
