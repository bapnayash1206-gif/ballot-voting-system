export const initialPolls = [
  {
    id: 'ABC123', question: 'Which campus event should we host this semester?',
    options: ['Outdoor movie night', 'Campus food festival', 'Live music showcase', 'Game and trivia night'],
    votingType: 'single', visibility: 'live', audience: 'public', chatEnabled: true,
    status: 'active', durationMinutes: 45, startedAt: Date.now() - 12 * 60_000,
    votes: [9, 7, 5, 3], voteCount: 24,
  },
  {
    id: 'QZ714F', question: 'What should the student club fund next?',
    options: ['Workshop supplies', 'Guest speaker series', 'Community volunteering'],
    votingType: 'ranked', visibility: 'after-close', audience: 'anonymous', chatEnabled: false,
    status: 'closed', durationMinutes: 60, startedAt: Date.now() - 90 * 60_000,
    votes: [18, 12, 10], voteCount: 40,
  },
]

export const initialChats = {
  ABC123: [
    { id: 'm1', sender: 'Maya R.', text: 'A movie night on the lawn would be so fun!', time: Date.now() - 8 * 60_000 },
    { id: 'm2', sender: 'Jordan K.', text: 'Food festival gets my vote 🌮', time: Date.now() - 5 * 60_000 },
  ],
  QZ714F: [],
}
