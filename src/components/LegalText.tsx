import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { LEGAL_FILE_TO_PAGE } from '@/lib/legal';
import { colors, font, radius, space } from '@/theme';

// Shows one of the legal documents (written in simple Markdown) as normal app text: headings, paragraphs,
// lists, quotes, tables, **bold** and links (links to the other documents open them in the app).
export function LegalText({ markdown }: { markdown: string }) {
  return <View style={styles.wrap}>{blocks(markdown)}</View>;
}

function blocks(markdown: string): ReactNode[] {
  const lines = markdown.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const push = (node: ReactNode) => out.push(<View key={out.length}>{node}</View>);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      push(<Text style={level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3}>{inline(heading[2])}</Text>);
      i += 1;
      continue;
    }
    // Table: header row, a |---| row, then body rows. Shown as one card per row: "Header: value" lines.
    if (trimmed.startsWith('|') && /^\|\s*:?-{2,}/.test(lines[i + 1]?.trim() ?? '')) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const header = cells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      push(
        <View style={styles.table}>
          {rows.map((row, r) => (
            <View key={r} style={styles.tableRow}>
              {row.map((cell, c) =>
                cell ? (
                  <Text key={c} style={c === 0 ? styles.tableFirst : styles.body}>
                    {c === 0 ? null : <Text style={styles.tableLabel}>{header[c]}: </Text>}
                    {inline(cell)}
                  </Text>
                ) : null,
              )}
            </View>
          ))}
        </View>,
      );
      continue;
    }
    // Quote (the "I understand" text and similar)
    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      push(<View style={styles.quote}>{blocks(quoted.join('\n'))}</View>);
      continue;
    }
    // Bulleted or numbered list
    const listItem = /^(?:[-*]|(\d+)\.)\s+(.*)$/;
    if (listItem.test(trimmed)) {
      const items: { mark: string; text: string }[] = [];
      while (i < lines.length && lines[i].trim()) {
        const match = listItem.exec(lines[i].trim());
        if (match) {
          items.push({ mark: match[1] ? `${match[1]}.` : '•', text: match[2] });
        } else if (items.length > 0) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // a wrapped line of the same item
        }
        i += 1;
      }
      push(
        <View style={styles.list}>
          {items.map((item, n) => (
            <View key={n} style={styles.listItem}>
              <Text style={styles.listMark}>{item.mark}</Text>
              <Text style={styles.listText}>{inline(item.text)}</Text>
            </View>
          ))}
        </View>,
      );
      continue;
    }
    // Paragraph: lines up to the next blank line or block.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>|\||[-*]\s|\d+\.\s)/.test(lines[i].trim())
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length === 0) {
      // A line that looks like the start of a block but isn't one (e.g. a lone "|"): show it as text.
      paragraph.push(trimmed);
      i += 1;
    }
    push(<Text style={styles.body}>{inline(paragraph.join(' '))}</Text>);
  }
  return out;
}

// **bold**, `code` and [links](target) inside a line of text.
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\[([^\]]+)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const key = parts.length;
    if (match[1] !== undefined) {
      parts.push(
        <Text key={key} style={styles.bold}>
          {inline(match[1])}
        </Text>,
      );
    } else if (match[2] !== undefined) {
      parts.push(
        <Text key={key} style={styles.code}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      const label = match[3];
      const target = match[4];
      const page = LEGAL_FILE_TO_PAGE[target.split('#')[0]];
      const open = page
        ? () => router.push({ pathname: '/legal/[doc]', params: { doc: page } })
        : /^(https?:|mailto:)/.test(target)
          ? () => Linking.openURL(target).catch(() => {})
          : null;
      parts.push(
        <Text key={key} style={open ? styles.link : undefined} onPress={open ?? undefined}>
          {label}
        </Text>,
      );
    } else {
      // A placeholder like [CONTACT EMAIL] or a bracketed button label: shown as it is.
      parts.push(`[${match[5]}]`);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.md,
  },
  h1: {
    ...font.title,
  },
  h2: {
    ...font.heading,
    marginTop: space.md,
  },
  h3: {
    ...font.body,
    fontWeight: '900',
    marginTop: space.sm,
  },
  body: {
    ...font.body,
    lineHeight: 22,
  },
  bold: {
    fontWeight: '800',
  },
  code: {
    fontFamily: 'Courier',
    fontSize: 14,
  },
  link: {
    color: colors.accent,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  list: {
    gap: space.sm,
  },
  listItem: {
    flexDirection: 'row',
    gap: space.sm,
  },
  listMark: {
    ...font.body,
    color: colors.accent,
    fontWeight: '800',
    minWidth: 18,
  },
  listText: {
    ...font.body,
    flex: 1,
    lineHeight: 22,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    padding: space.md,
  },
  table: {
    gap: space.sm,
  },
  tableRow: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    gap: 4,
  },
  tableFirst: {
    ...font.body,
    fontWeight: '900',
  },
  tableLabel: {
    fontWeight: '800',
    color: colors.textMuted,
  },
});
