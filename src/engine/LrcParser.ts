import type { LyricLine } from '../types'

/**
 * LRC 歌词解析器
 * 支持格式：
 *   [mm:ss.xx]歌词文本
 *   [mm:ss]歌词文本
 *   [mm:ss.xx]<mm:ss.xx>逐字 | <mm:ss.xx>逐字
 */
export class LrcParser {
  /**
   * 解析 LRC 文本内容
   */
  static parse(lrcContent: string): LyricLine[] {
    const lines = lrcContent.split(/\r?\n/)
    const lyrics: LyricLine[] = []

    // 标签匹配：方括号内冒号或点分隔
    const tagRegex = /\[(\d+):(\d+(?:\.\d+)?)\]/g
    // 逐字时间匹配：<mm:ss.xx>
    const wordRegex = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // 跳过元数据标签
      if (/^\[(ti|ar|al|by|offset|re|ve):/i.test(trimmed)) continue

      let match: RegExpExecArray | null
      let lastIndex = 0
      const timestamps: number[] = []

      // 提取所有时间标签
      tagRegex.lastIndex = 0
      while ((match = tagRegex.exec(trimmed)) !== null) {
        const minutes = parseInt(match[1], 10)
        const seconds = parseFloat(match[2])
        timestamps.push(minutes * 60 + seconds)
        lastIndex = match.index + match[0].length
      }

      if (timestamps.length === 0) continue

      // 提取标签后的文本
      let text = trimmed.slice(lastIndex).trim()

      // 尝试解析逐字时间
      const wordTimestamps: { time: number; word: string }[] = []
      let wordMatch: RegExpExecArray | null
      wordRegex.lastIndex = 0
      let plainText = text

      if (wordRegex.test(text)) {
        // 包含逐字时间信息
        wordRegex.lastIndex = 0
        plainText = ''
        while ((wordMatch = wordRegex.exec(text)) !== null) {
          const wm = parseInt(wordMatch[1], 10)
          const ws = parseFloat(wordMatch[2])
          const wText = wordMatch[3]
          wordTimestamps.push({ time: wm * 60 + ws, word: wText })
          plainText += wText
        }
        // 清理：移除尖括号标签
        text = plainText || text.replace(/<\d+:\d+(?:\.\d+)?>/g, '')
      }

      for (const startTime of timestamps) {
        lyrics.push({ startTime, text, wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : undefined })
      }
    }

    // 按时间排序
    lyrics.sort((a, b) => a.startTime - b.startTime)

    return lyrics
  }

  /**
   * 将 LyricLine 数组转换为 SRT 字幕格式
   */
  static toSrt(lyrics: LyricLine[], totalDuration: number): string {
    const lines: string[] = []

    for (let i = 0; i < lyrics.length; i++) {
      const current = lyrics[i]
      const next = lyrics[i + 1]
      const endTime = next ? Math.min(next.startTime, current.startTime + 5) : totalDuration

      lines.push(String(i + 1))
      lines.push(`${this.formatSrtTime(current.startTime)} --> ${this.formatSrtTime(endTime)}`)
      lines.push(current.text)
      lines.push('') // 空行分隔
    }

    return lines.join('\n')
  }

  /**
   * 格式化 SRT 时间戳: HH:MM:SS,mmm
   */
  private static formatSrtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const ms = Math.floor((seconds % 1) * 1000)
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`
  }
}
