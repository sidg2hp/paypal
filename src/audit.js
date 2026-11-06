'use strict';

const crypto = require('node:crypto');

/**
 * Tamper-evident audit trail.
 *
 * Every invoice timeline event carries the hash of the previous event, so any
 * edit to an earlier event invalidates every hash after it. This is deliberately
 * small and dependency-free: judges can read the whole implementation in one
 * sitting, and the UI can verify the chain on demand.
 */

function canonicalEvent(event) {
  return JSON.stringify({
    type: event.type || null,
    at: event.at || null,
    source: event.source || null,
    verified: Boolean(event.verified),
    eventId: event.eventId || null,
    actor: event.actor || null,
    detail: event.detail || null
  });
}

function hashEvent(event, previousHash = '') {
  return crypto.createHash('sha256').update(`${previousHash}\n${canonicalEvent(event)}`).digest('hex');
}

function appendEvent(events, event) {
  const previousHash = events.length ? events[events.length - 1].hash || '' : '';
  const sealed = { ...event, prevHash: previousHash, hash: hashEvent(event, previousHash) };
  events.push(sealed);
  return sealed;
}

function verifyChain(events = []) {
  let previousHash = '';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = hashEvent(event, previousHash);
    if (event.prevHash !== previousHash || event.hash !== expected) {
      return { valid: false, checked: index + 1, total: events.length, brokenAt: index, brokenEventType: event.type || null };
    }
    previousHash = event.hash;
  }
  return { valid: true, checked: events.length, total: events.length, brokenAt: null, brokenEventType: null };
}

module.exports = { appendEvent, canonicalEvent, hashEvent, verifyChain };
