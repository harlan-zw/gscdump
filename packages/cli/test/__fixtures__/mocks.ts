import type { OAuth2Client } from 'google-auth-library'
import type { Credentials } from 'google-auth-library/build/src/auth/credentials.js'
import { vi } from 'vitest'

export const mockCredentials: Credentials = {
  access_token: 'mock_access_token',
  refresh_token: 'mock_refresh_token',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600000, // 1 hour from now
}

export const mockExpiredCredentials: Credentials = {
  access_token: 'mock_access_token',
  refresh_token: 'mock_refresh_token',
  token_type: 'Bearer',
  expiry_date: Date.now() - 3600000, // 1 hour ago
}

export const mockAuth = {
  credentials: mockCredentials,
  generateAccessToken: vi.fn().mockResolvedValue({ token: 'mock_access_token' }),
  setCredentials: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue({ credentials: mockCredentials }),
  generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
  getToken: vi.fn().mockResolvedValue({ tokens: mockCredentials }),
} as unknown as OAuth2Client

export const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://test.example.com/', permissionLevel: 'siteFullUser' },
]

export const mockPageData = [
  { page: 'https://example.com/', clicks: 1200, impressions: 8400, ctr: 0.1429, position: 3.2 },
  { page: 'https://example.com/guide', clicks: 800, impressions: 6400, ctr: 0.125, position: 4.8 },
]

export const mockKeywordData = [
  { keyword: 'best practices', clicks: 450, impressions: 3600, ctr: 0.125, position: 4.2 },
  { keyword: 'how to guide', clicks: 380, impressions: 4560, ctr: 0.0833, position: 5.8 },
]

export const mockCountryData = [
  { countryCodeGsc: 'usa', country: 'United States', countryCode: 'US', clicks: 2800, impressions: 22400, ctr: 0.125, position: 7.2 },
  { countryCodeGsc: 'gbr', country: 'United Kingdom', countryCode: 'GB', clicks: 420, impressions: 3360, ctr: 0.125, position: 7.5 },
]

export const mockDeviceData = [
  { device: 'desktop', clicks: 1250, impressions: 12580, ctr: 0.0994, position: 8.2 },
  { device: 'mobile', clicks: 2100, impressions: 18420, ctr: 0.114, position: 6.8 },
]

export const mockAnalyticsWithComparison = {
  current: mockPageData,
  previous: mockPageData,
  metadata: { startDate: '2024-01-01', endDate: '2024-01-31' },
}

export const mockKeywordsWithComparison = {
  current: mockKeywordData,
  previous: mockKeywordData,
  metadata: { startDate: '2024-01-01', endDate: '2024-01-31' },
}

export const mockCountriesWithComparison = {
  current: mockCountryData,
  previous: mockCountryData,
  metadata: { startDate: '2024-01-01', endDate: '2024-01-31' },
}

export const mockDevicesWithComparison = {
  current: mockDeviceData,
  previous: mockDeviceData,
  metadata: { startDate: '2024-01-01', endDate: '2024-01-31' },
}
