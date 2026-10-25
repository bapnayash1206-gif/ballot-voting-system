import { randomBytes } from 'node:crypto'

export const DEMO_VOTERS = Array.from({ length: 10 }, (_, index) => `demo_voter${String(index + 1).padStart(2, '0')}`)

export const DEMO_POLLS = [
  {
    key: 'campus-events',
    question: '[Demo] Which campus event would you prefer?',
    votingType: 'single',
    options: ['Technical Fest', 'Cultural Fest', 'Sports Fest'],
    desiredStatus: 'active',
  },
  {
    key: 'technical-workshop',
    question: '[Demo] Which technical workshop interests you most?',
    votingType: 'multiple',
    options: ['Artificial Intelligence', 'Web Development', 'Cybersecurity', 'Cloud Computing'],
    desiredStatus: 'active',
  },
  {
    key: 'campus-improvements',
    question: '[Demo] Which campus improvement should be prioritized?',
    votingType: 'ranked',
    options: ['Better study spaces', 'Improved Wi-Fi', 'More sports facilities', 'Better cafeteria options'],
    desiredStatus: 'closed',
  },
]

export const DEMO_BALLOT_PLANS = {
  'campus-events': [
    [0, [0]], [1, [1]], [2, [2]], [3, [0]], [4, [1]], [5, [2]],
  ],
  'technical-workshop': [
    [0, [0, 1]], [2, [2]], [4, [3, 0]], [7, [1]],
  ],
  'campus-improvements': [
    [1, [0, 1, 2, 3]], [3, [1, 2, 0, 3]], [5, [2, 3, 1, 0]],
    [6, [3, 0, 1, 2]], [8, [1, 0, 3, 2]],
  ],
}

export function generateTemporaryPassword() {
  return randomBytes(18).toString('base64url')
}

export function parseCredentialReport(contents = '') {
  const credentials = new Map()
  for (const line of String(contents).split(/\r?\n/)) {
    const match = line.match(/^(demo_voter\d{2})\t([A-Za-z0-9_-]{20,})$/)
    if (match) credentials.set(match[1], match[2])
  }
  return credentials
}

export function formatCredentialEntries(entries) {
  return entries.map(({ username, password }) => `${username}\t${password}`).join('\n') + (entries.length ? '\n' : '')
}
