import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import process from 'node:process'

/** Read a visible line using readline's terminal handling in PowerShell and VS Code. */
export async function promptLine(label, { input = process.stdin, output = process.stdout } = {}) {
  const reader = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) })
  try {
    return (await reader.question(label)).trim()
  } finally {
    reader.close()
  }
}

/** Read a password in raw mode so typed characters are never echoed. */
export function promptSecret(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Admin password must be entered in a local interactive terminal; it is never accepted as a command-line argument.'))
  }

  emitKeypressEvents(input)
  output.write(label)
  input.setRawMode(true)
  input.resume()

  let value = ''
  return new Promise((resolveAnswer, reject) => {
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      input.removeListener('keypress', onKey)
      input.removeListener('close', onClose)
      input.setRawMode(false)
      output.write('\n')
      if (error) reject(error)
      else resolveAnswer(value)
    }
    const onClose = () => finish(new Error('Input ended before the password prompt was answered.'))
    const onKey = (character, key = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return finish(new Error('Setup cancelled.'))
      if (key.name === 'return' || key.name === 'enter') return finish()
      if (key.name === 'backspace') {
        value = value.slice(0, -1)
        return
      }
      if (!key.ctrl && !key.meta && character) value += character
    }
    input.on('keypress', onKey)
    input.once('close', onClose)
  })
}
