process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-test-value';
process.env.FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || 'football-data-test-key';
process.env.WRITER_PASSWORD = process.env.WRITER_PASSWORD || 'testpass';

const request = require('supertest');
const app = require('../server');

module.exports = { request, app, TEST_PASSWORD: process.env.WRITER_PASSWORD };