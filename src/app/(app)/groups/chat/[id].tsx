import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { ChatBackground, ChatInkProvider, chatInk } from '@/components/chat/ChatBackground';
import { ChatBackgroundPicker } from '@/components/chat/ChatBackgroundPicker';
import { ChatSticker } from '@/components/chat/ChatSticker';
import { StickerPicker } from '@/components/editor/StickerPicker';
import { DareComposer } from '@/components/DareComposer';
import { MessageActions, ReactionChips, ReplyQuote, type MessageAction } from '@/components/MessageActions';
import { EmptyState } from '@/components/EmptyState';
import { GroupFaces } from '@/components/GroupFaces';
import { GroupGuessCard } from '@/components/groups/GroupGuessCard';
import { IconButton } from '@/components/IconButton';
import { useOverlays, type SheetOption } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { SafeEdge } from '@/components/SafeEdge';
import { ZoomableImage } from '@/components/ZoomableImage';
import { VideoClip } from '@/components/VideoClipSafe';
import { MicButton, VoiceBubble, type Recording } from '@/components/VoiceNote';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { StoryAvatar } from '@/components/StoryAvatar';
import { useMe } from '@/lib/auth';
import { groupChatKey, useChatBackground } from '@/lib/chatBackgrounds';
import { canSendSticker, isKnownSticker, stickerText, wordStickerId } from '@/lib/chatStickers';
import { friendlyError } from '@/lib/errors';
import {
  canVoteOnProof,
  deleteGroupMessage,
  fetchGroupChats,
  fetchGroupMessages,
  fetchGroupReads,
  fetchMyGroupJoin,
  fetchMyProofVotes,
  markGroupChatRead,
  pinGroupMessage,
  proofCounts,
  proofOutcome,
  searchGroupMessages,
  sendGroupDare,
  sendGroupMessage,
  sendGroupSticker,
  sendGroupVoice,
  setGroupChatMuted,
  setGroupPhoto,
  subscribeToGroup,
  subscribeToGroupChat,
  voteGroupProof,
  type GroupChatChange,
  type GroupMessage,
} from '@/lib/groupChat';
import { fetchGroup, type PeekGroup } from '@/lib/groups';
import { fetchGroupGuesses, subscribeToGroupGuesses, type GroupGuess, type GroupGuessFeed } from '@/lib/groupGuess';
import { blockMysteryPoster, deleteMystery, guessMystery, reportMystery } from '@/lib/guess';
import { usePlus } from '@/lib/plus';
import { useMediaUrls } from '@/lib/media';
import { fetchReactions, subscribeToReactions, toggleReaction, type Reaction } from '@/lib/reactions';
import { REPORT_REASONS } from '@/lib/safety';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useGroupTyping } from '@/lib/typing';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { Audio } from '@/lib/voice';
import { useOpenChat } from '@/lib/notifications';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// How often to check who has read the chat (for "Seen by …") while it's open. The group Guess Whos are checked
// again at the same time (for the guess counts, and to hide ones that have ended).
const READS_EVERY_MS = 15_000;

// One row of the chat: a message, or a group Guess Who 🕵️. A Guess Who is not a message: it has no sender on
// it, so it never joins a run of someone's messages and has no reply, pin, reactions or "See profile".
type ChatItem = { message: GroupMessage; guess?: undefined } | { guess: GroupGuess; message?: undefined };
// Guess Who ids are a different kind of id, so they get their own prefix (they can never clash with a message).
const itemKey = (item: ChatItem) => (item.guess ? `guess:${item.guess.id}` : item.message.id);
const itemTime = (item: ChatItem) => Date.parse(item.guess ? item.guess.created_at : item.message.created_at);
// What the full-screen viewer needs: just the picture's files.
type ViewerMedia = {
  media_path: string | null;
  media_type: 'photo' | 'video' | null;
  poster_path: string | null;
  overlay_path: string | null;
};

// A group's chat 💬: texts, photos and videos (📷), voice notes (hold 🎤), and group dares (🚩) where everyone
// posts their proof and the rest of the group votes on it: Legit 🔥 or Cap 🧢. "Typing…" and "Seen by" like a
// one-on-one chat. 🔎 searches the chat. 🕵️ Group Guess Whos (a photo with no name on it – the group guesses who
// sent it) sit in the middle of the chat between the messages.
// Tap the top to see the group (drops, members). Hold a message: yours → delete for everyone; theirs → report.
export default function GroupChat() {
  const { id: groupId } = useLocalSearchParams<{ id: string }>();
  // While this chat is open, its own new messages don't also pop up as a notification banner.
  useOpenChat(`group:${groupId}`);
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  // Your moving background for this group chat (Peekaboo+ ⭐). Only you see it.
  const background = useChatBackground(groupChatKey(groupId));
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const ink = chatInk(background.shown);
  const insets = useSafeAreaInsets();
  const [group, setGroup] = useState<PeekGroup | null | undefined>(undefined);
  const [messages, setMessages] = useState<GroupMessage[] | null>(null);
  const [reads, setReads] = useState<Map<string, string>>(new Map());
  const [muted, setMuted] = useState(false);
  const [text, setText] = useState('');
  const draft = useRef('');
  const sendingNow = useRef(false);
  const [sending, setSending] = useState(false);
  const [dareOpen, setDareOpen] = useState(false);
  // Search: the box is open while `search` isn't null.
  const [search, setSearch] = useState<string | null>(null);
  const [results, setResults] = useState<{ query: string; list: GroupMessage[] } | null>(null);
  const searchRequest = useRef(0);
  const listRef = useRef<FlatList<ChatItem>>(null);
  // Reactions, the message you're holding (its menu), and the message you're replying to.
  const [reactions, setReactions] = useState<Map<string, Reaction[]>>(new Map());
  const [menuFor, setMenuFor] = useState<{ message: GroupMessage; actions: MessageAction[] } | null>(null);
  const [replyTo, setReplyTo] = useState<GroupMessage | null>(null);
  // The photo or video open full screen (`key` is its row in the chat, so it closes if that row goes away).
  const [viewing, setViewing] = useState<{ key: string; media: ViewerMedia } | null>(null);
  // Your own votes on the proofs in this chat (proof id → true for legit, false for cap), and the proofs whose
  // vote is being sent right now (a second tap waits for the first).
  const [myVotes, setMyVotes] = useState<Map<string, boolean>>(new Map());
  const votesRequest = useRef(0);
  const voting = useRef(new Set<string>());
  const [busyVotes, setBusyVotes] = useState<Set<string>>(new Set());
  // When you joined this group: only people who were in it when a proof was posted can vote on that proof.
  // null until it's loaded (or if it can't be): then the buttons show and the server decides. It is read again
  // with every reload of the chat and after a refused vote (you may have been removed and added back, which
  // makes it later); an answer that comes back after a newer one is dropped.
  const [joined, setJoined] = useState<{ user: string; group: string; at: string | null } | null>(null);
  const joinedAt = joined?.user === userId && joined.group === groupId ? joined.at : null;
  const joinRequest = useRef(0);
  const refreshJoin = useCallback(() => {
    const request = ++joinRequest.current;
    fetchMyGroupJoin(groupId, userId)
      .then((at) => {
        if (request === joinRequest.current) setJoined({ user: userId, group: groupId, at });
      })
      .catch(() => {});
  }, [groupId, userId]);
  // How many times each proof's vote totals changed on screen (a live update, or the answer to your vote). An
  // answer that set off before the latest change can be older than what's shown, so it doesn't replace it.
  const totalsChanges = useRef(new Map<string, number>());
  const { typing, onTextChange, clearTyping } = useGroupTyping(userId, groupId, group !== null);

  // 🕵️ The group Guess Whos in this chat. null = none yet, or a server that doesn't have them yet (then the chat
  // works just like before). If loading fails for another reason, the ones on screen stay.
  const [guesses, setGuesses] = useState<GroupGuessFeed | null>(null);
  const guessesRequest = useRef(0);
  const guessingNow = useRef(false);
  const [guessing, setGuessing] = useState<string | null>(null);
  // Guess Whos you just guessed, to play the reveal once.
  const [justRevealed, setJustRevealed] = useState<Set<string>>(new Set());
  // The time now, to hide Guess Whos that have ended (moved on every 15 seconds, when you come back to the chat,
  // and after a refused guess).
  const [now, setNow] = useState(() => Date.now());
  const moveClock = useCallback(() => setNow(Date.now()), []);
  // Only loads the Guess Whos: it never marks the chat as read (a new Guess Who mustn't move anyone's "Seen").
  // An answer that set off before a newer one is dropped.
  const loadGuesses = useCallback(() => {
    const request = ++guessesRequest.current;
    fetchGroupGuesses(groupId)
      .then((found) => {
        if (request === guessesRequest.current) setGuesses(found);
      })
      .catch((error) => console.warn('Could not load the group Guess Whos', error));
  }, [groupId]);

  const load = useCallback(() => {
    const changesBefore = new Map(totalsChanges.current);
    refreshJoin();
    loadGuesses();
    fetchGroupMessages(groupId)
      .then((list) => {
        // Vote totals that changed on screen while this was loading are newer than the ones it brought back.
        setMessages((current) =>
          list.map((m) => {
            if ((totalsChanges.current.get(m.id) ?? 0) === (changesBefore.get(m.id) ?? 0)) return m;
            const shown = current?.find((c) => c.id === m.id);
            return shown ? { ...m, proof_legit: shown.proof_legit, proof_cap: shown.proof_cap, proof_legacy: shown.proof_legacy } : m;
          }),
        );
        fetchReactions(
          list.map((m) => m.id),
          true,
        )
          .then(setReactions)
          .catch(() => {});
        // Their message arrived: they've stopped typing.
        if (list[0]) clearTyping(list[0].sender_id);
        markGroupChatRead(groupId).catch(() => {});
        // An answer that comes back after you voted again is old news, so it's dropped.
        const request = ++votesRequest.current;
        fetchMyProofVotes(
          userId,
          list.filter((m) => m.kind === 'proof').map((m) => m.id),
        )
          .then((votes) => {
            if (request === votesRequest.current) setMyVotes(votes);
          })
          .catch(() => {});
      })
      .catch((error) => {
        console.warn('Could not load the group chat', error);
        setMessages((current) => current ?? []);
      });
    fetchGroupReads(groupId)
      .then(setReads)
      .catch(() => {});
  }, [groupId, userId, clearTyping, refreshJoin, loadGuesses]);

  // Live changes: a vote changed a proof's totals → just those numbers change; anything else → load again.
  const onChatChange = useCallback(
    (change: GroupChatChange) => {
      const row = change.message;
      if (change.event === 'UPDATE' && row.id) {
        totalsChanges.current.set(row.id, (totalsChanges.current.get(row.id) ?? 0) + 1);
        setMessages(
          (current) =>
            current?.map((m) =>
              m.id === row.id
                ? { ...m, proof_legit: row.proof_legit ?? m.proof_legit, proof_cap: row.proof_cap ?? m.proof_cap, proof_legacy: row.proof_legacy ?? m.proof_legacy }
                : m,
            ) ?? current,
        );
        return;
      }
      load();
    },
    [load],
  );

  useFocusEffect(
    useCallback(() => {
      // Back in the chat: Guess Whos that ended while you were away are hidden straight away (even before the
      // reload below comes back, or if it can't).
      moveClock();
      fetchGroup(groupId)
        .then(setGroup)
        .catch(() => setGroup(null));
      fetchGroupChats()
        .then((chats) => setMuted(chats.get(groupId)?.muted ?? false))
        .catch(() => {});
      load();
      const stop = subscribeToGroupChat(groupId, onChatChange);
      const stopReactions = subscribeToReactions(true, load);
      const stopGroup = subscribeToGroup(groupId, () => {
        fetchGroup(groupId)
          .then(setGroup)
          .catch(() => {});
      });
      // A group Guess Who was posted or deleted: load just the Guess Whos again (never the whole chat, which
      // would mark it as read).
      const stopGuesses = subscribeToGroupGuesses(groupId, loadGuesses);
      const readsTimer = setInterval(() => {
        fetchGroupReads(groupId)
          .then(setReads)
          .catch(() => {});
        loadGuesses();
        setNow(Date.now());
      }, READS_EVERY_MS);
      return () => {
        stop();
        stopReactions();
        stopGroup();
        stopGuesses();
        clearInterval(readsTimer);
      };
    }, [groupId, load, onChatChange, loadGuesses, moveClock]),
  );

  const people = new Map<string, Profile>();
  for (const member of group?.members ?? []) if (member.profile) people.set(member.userId, member.profile);
  const nameOf = (id: string) => {
    const person = people.get(id);
    return person ? person.display_name || person.username : 'Someone';
  };

  // The group Guess Whos still running, and everything in the chat newest first: the messages and the Guess Whos,
  // by when they were sent.
  const shownGuesses = (guesses?.posts ?? []).filter((post) => Date.parse(post.expires_at) > now);
  const items: ChatItem[] =
    messages === null
      ? []
      : [...messages.map((message) => ({ message })), ...shownGuesses.map((guess) => ({ guess }))].sort(
          (a, b) => itemTime(b) - itemTime(a),
        );

  // Photos, videos, proofs and Guess Whos need their links.
  const paths = [
    ...(messages ?? []).flatMap((m) => [m.media_path, m.poster_path, m.overlay_path]),
    ...shownGuesses.flatMap((post) => [post.media_path, post.poster_path, post.overlay_path]),
  ].filter((p): p is string => !!p && !p.includes('/voice/'));
  const urls = useMediaUrls(paths);

  // Group dares: who has a proof that counts for each one (the group voted legit), and your own newest proof.
  const proofsByDare = new Map<string, Set<string>>();
  const myProofByDare = new Map<string, GroupMessage>();
  for (const m of messages ?? []) {
    if (m.kind === 'proof' && m.dare_id) {
      if (proofCounts(m)) {
        const set = proofsByDare.get(m.dare_id) ?? new Set<string>();
        set.add(m.sender_id);
        proofsByDare.set(m.dare_id, set);
      }
      // The list is newest first.
      if (m.sender_id === userId && !myProofByDare.has(m.dare_id)) myProofByDare.set(m.dare_id, m);
    }
  }

  async function send() {
    const originalText = text;
    const body = text.trim();
    if (!body || sendingNow.current) return;
    sendingNow.current = true;
    const replyId = replyTo?.id;
    setSending(true);
    try {
      const sent = await sendGroupMessage(groupId, body, replyId);
      setReplyTo((current) => current?.id === replyId ? null : current);
      // Leave the next draft alone if you started typing while this message was sending.
      if (draft.current === originalText) {
        draft.current = '';
        setText('');
        onTextChange('');
      }
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  async function sendVoiceNote(recording: Recording) {
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    try {
      const sent = await sendGroupVoice(userId, groupId, recording.uri, recording.durationMs, recording.waveform);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Voice note not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  // 🏷️ Stickers. Peekaboo+ ones are locked in the picker without Peekaboo+ (and the server says no too).
  const plus = usePlus();
  const [stickersOpen, setStickersOpen] = useState(false);
  async function sendStickerMessage(sticker: string) {
    setStickersOpen(false);
    if (!canSendSticker(sticker, plus)) {
      router.push('/plus');
      return;
    }
    const replyId = replyTo?.id;
    try {
      const sent = await sendGroupSticker(groupId, sticker, stickerText(sticker), replyId);
      Haptics.selectionAsync();
      setReplyTo((current) => (current?.id === replyId ? null : current));
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Sticker not sent', friendlyError(error));
    }
  }
  // An emoji from the sticker picker goes as a normal chat message.
  async function sendEmoji(emoji: string) {
    setStickersOpen(false);
    const replyId = replyTo?.id;
    try {
      const sent = await sendGroupMessage(groupId, emoji, replyId);
      setReplyTo((current) => (current?.id === replyId ? null : current));
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    }
  }

  async function sendDare(dare: string): Promise<boolean> {
    try {
      const sent = await sendGroupDare(groupId, dare);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
      showToast('Dared the whole group 🎯');
      return true;
    } catch (error) {
      Alert.alert('Dare not sent', friendlyError(error));
      return false;
    }
  }

  // 🔥 / 🧢 on someone's proof. Tapping the vote you already gave takes it back.
  async function voteOn(proof: GroupMessage, legit: boolean) {
    if (voting.current.has(proof.id)) return;
    voting.current.add(proof.id);
    setBusyVotes((current) => new Set(current).add(proof.id));
    const choice = myVotes.get(proof.id) === legit ? null : legit;
    const changesBefore = totalsChanges.current.get(proof.id) ?? 0;
    try {
      const result = await voteGroupProof(userId, proof.id, choice);
      // Your vote as the server has it now. Older "your votes" answers still on the way are dropped.
      votesRequest.current++;
      setMyVotes((current) => {
        const next = new Map(current);
        if (result.mine === null) next.delete(proof.id);
        else next.set(proof.id, result.mine);
        return next;
      });
      // The new totals – unless a live update came in while your vote was on its way (that one is newer).
      if ((totalsChanges.current.get(proof.id) ?? 0) === changesBefore) {
        totalsChanges.current.set(proof.id, changesBefore + 1);
        setMessages(
          (current) =>
            current?.map((m) =>
              m.id === proof.id ? { ...m, proof_legit: result.legit, proof_cap: result.cap, proof_legacy: result.legacy ?? m.proof_legacy } : m,
            ) ?? current,
        );
      }
      Haptics.selectionAsync();
      showToast(choice === null ? 'Vote taken back' : choice ? 'You said legit 🔥' : 'You called cap 🧢');
    } catch (error) {
      showToast(`Vote not saved – ${friendlyError(error)}`);
      // Maybe you were removed and added back since the chat opened: check your join time again.
      refreshJoin();
    } finally {
      voting.current.delete(proof.id);
      setBusyVotes((current) => {
        const next = new Set(current);
        next.delete(proof.id);
        return next;
      });
    }
  }

  // The label on a proof: what the group decided so far.
  const proofLabel = (m: GroupMessage) => {
    switch (proofOutcome(m)) {
      case 'legacy':
        return '✅ Did the dare';
      case 'counts':
        return '✅ Legit – it counts';
      case 'tie':
        return '⚖️ Tie – not decided';
      case 'cap':
        return "🧢 Cap – doesn't count";
      default:
        return canVoteOnProof(m, userId, joinedAt) ? '⏳ Legit or cap? Vote!' : '⏳ Waiting for votes';
    }
  };
  // Under the dare, for you: why your proof doesn't count (yet).
  const myProofNote = (m: GroupMessage) => {
    switch (proofOutcome(m)) {
      case 'tie':
        return "⚖️ Your proof is a tie so far – it doesn't count yet";
      case 'cap':
        return '🧢 The group said cap – post new proof?';
      default:
        return '⏳ Your proof is waiting for votes';
    }
  };

  // 🕵️ The camera only offers a Guess Who when it can work here: the group has at least 3 people (with 2, the other
  // person would know it was you) and the server has group Guess Who (the list loaded, not null). Never in the
  // camera for a group dare proof.
  const guessWhoOk = (group?.members.length ?? 0) >= 3 && guesses !== null;
  const openCamera = (dareId?: string) =>
    router.push({
      pathname: '/camera',
      params: { group: groupId, ...(dareId ? { groupDare: dareId } : guessWhoOk ? { groupGuessOk: '1' } : {}) },
    });

  const pinnedId = group?.pinned_message_id ?? null;

  async function pin(message: GroupMessage | null) {
    try {
      await pinGroupMessage(groupId, message?.id ?? null);
      setGroup((current) => (current ? { ...current, pinned_message_id: message?.id ?? null } : current));
      showToast(message ? 'Pinned to the top 📌' : 'Unpinned');
    } catch (error) {
      Alert.alert('Could not pin', friendlyError(error));
    }
  }

  // 🕵️ Your one guess on a group Guess Who. The answer (who really sent it) is only shown to you.
  // The answer on the card always comes from the server: the guess it has saved for you and who really sent it –
  // never just the name you tapped. (If you already guessed on another phone, that first guess is the one that
  // counts.) Until that answer is back the card stays busy, so a second tap can't send a second guess.
  async function guessWho(post: GroupGuess, choice: string) {
    if (guessingNow.current) return;
    guessingNow.current = true;
    setGuessing(post.id);
    try {
      try {
        await guessMystery(post.id, choice);
      } catch (error) {
        Alert.alert('Could not guess', friendlyError(error));
        // It may have ended or been deleted, or someone may have left: show the Guess Whos as they are now.
        moveClock();
        loadGuesses();
        return;
      }
      // A Guess Who list still on its way (from before your guess) is old news, so it's dropped.
      const request = ++guessesRequest.current;
      const found = await fetchGroupGuesses(groupId);
      if (request === guessesRequest.current) setGuesses(found);
      const saved = found?.posts.find((p) => p.id === post.id);
      if (saved && !saved.mine && saved.my_guess && saved.poster) {
        Haptics.notificationAsync(
          saved.my_guess === saved.poster ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
        );
        setJustRevealed((current) => new Set(current).add(post.id));
      }
    } catch (error) {
      // Your guess is saved, but the answer couldn't be loaded: it shows at the next check.
      console.warn('Could not load the group Guess Whos', error);
    } finally {
      guessingNow.current = false;
      setGuessing(null);
    }
  }

  const removeGuess = (id: string) =>
    setGuesses((current) => (current ? { ...current, posts: current.posts.filter((post) => post.id !== id) } : current));

  // ⋯ on a group Guess Who (or hold its photo). Yours: delete it. Someone else's: report it (nobody is told it was
  // you), and once you've guessed, block whoever sent it. No reply, pin, reactions or profile: it isn't a message.
  function openGuessMenu(post: GroupGuess) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (post.mine) {
      showOptions({
        options: [
          {
            label: 'Delete',
            destructive: true,
            onPress: () =>
              Alert.alert('Delete this Guess Who?', 'It will be gone for everyone.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deleteMystery(post);
                      removeGuess(post.id);
                      showToast('Deleted 🗑️');
                    } catch (error) {
                      Alert.alert('Could not delete', friendlyError(error));
                    }
                  },
                },
              ]),
          },
        ],
      });
      return;
    }
    const options: SheetOption[] = [
      {
        label: 'Report',
        onPress: () =>
          // Wait for this menu to close before opening the next one.
          setTimeout(
            () =>
              showOptions({
                title: 'Why are you reporting this?',
                message: "Your report is private – whoever posted it won't know it was you. We review every report within 24 hours.",
                options: REPORT_REASONS.map((reason) => ({
                  label: reason.label,
                  onPress: async () => {
                    try {
                      await reportMystery(post.id, reason.code);
                      Alert.alert('Thanks for telling us 💛', 'We will take a look.');
                    } catch (error) {
                      Alert.alert('Could not send report', friendlyError(error));
                    }
                  },
                })),
              }),
            400,
          ),
      },
    ];
    // Blocking is only offered after your guess: before it, it would tell you who it was.
    if (post.poster !== null) {
      options.push({
        label: 'Block whoever posted this',
        destructive: true,
        onPress: () =>
          Alert.alert(
            'Block whoever posted this?',
            "They won't be able to see your stuff or message you, and you'll stop seeing theirs. We won't tell them. (They'll show up in your Blocked accounts list.)",
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                onPress: async () => {
                  try {
                    await blockMysteryPoster(post.id);
                    removeGuess(post.id);
                    showToast('Blocked');
                    // Their messages leave the chat too.
                    load();
                  } catch (error) {
                    Alert.alert('Could not block', friendlyError(error));
                  }
                },
              },
            ],
          ),
      });
    }
    showOptions({ options });
  }

  function openMessageMenu(message: GroupMessage) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const sender = people.get(message.sender_id);
    const actions: MessageAction[] = [
      { label: '↩ Reply', onPress: () => setReplyTo(message) },
      pinnedId === message.id
        ? { label: '📌 Unpin', onPress: () => pin(null) }
        : { label: '📌 Pin to the top', onPress: () => pin(message) },
    ];
    if (message.sender_id === userId) {
      actions.push({
        label: 'Delete for everyone',
        destructive: true,
        onPress: async () => {
          try {
            await deleteGroupMessage(message);
            setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
            showToast('Deleted for everyone');
          } catch (error) {
            Alert.alert('Could not delete', friendlyError(error));
          }
        },
      });
    } else if (sender) {
      actions.push(
        { label: '👤 See profile', onPress: () => router.push(`/profile/${sender.id}`) },
        { label: 'Report', onPress: () => report({ user: sender, contentType: 'group_message', contentId: message.id }) },
      );
    }
    setMenuFor({ message, actions });
  }

  async function react(message: GroupMessage, emoji: string) {
    const mine = reactions.get(message.id)?.find((r) => r.user_id === userId)?.emoji ?? null;
    try {
      await toggleReaction(userId, message.id, emoji, mine, true);
      Haptics.selectionAsync();
      load();
    } catch (error) {
      Alert.alert('Could not react', friendlyError(error));
    }
  }

  // The group's picture: choose one (square), or remove it.
  async function changePhoto(remove = false) {
    try {
      if (remove) {
        await setGroupPhoto(userId, groupId, null);
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.9,
        });
        if (result.canceled || !result.assets[0]) return;
        await setGroupPhoto(userId, groupId, result.assets[0].uri);
      }
      setGroup(await fetchGroup(groupId));
      showToast(remove ? 'Group photo removed' : 'New group photo 📷');
    } catch (error) {
      Alert.alert('Could not change the photo', friendlyError(error));
    }
  }

  // A short description of any group message, for reply quotes and the pinned banner.
  const previewOf = (m: GroupMessage) =>
    m.kind === 'text'
      ? (m.body ?? '')
      : m.kind === 'photo'
        ? '📷 Photo'
        : m.kind === 'video'
          ? '🎬 Video'
          : m.kind === 'voice'
            ? '🎤 Voice note'
            : m.kind === 'dare'
              ? `🎯 ${m.body ?? ''}`
              : m.kind === 'sticker'
                ? '🏷️ Sticker'
                : '📸 Dare proof';

  function openGroupMenu() {
    showOptions({
      title: group?.name,
      options: [
        { label: '🔎 Search this chat', onPress: () => setSearch('') },
        { label: '📷 Change group photo', onPress: () => changePhoto() },
        ...(group?.photo_path ? [{ label: 'Remove group photo', onPress: () => changePhoto(true) }] : []),
        { label: '✏️ Change name & people', onPress: () => router.push({ pathname: '/groups/new', params: { group: groupId } }) },
        { label: '👯 Group info & drops', onPress: () => router.push(`/groups/${groupId}`) },
        { label: '🎨 Chat background', onPress: () => setBackgroundOpen(true) },
        {
          label: muted ? '🔔 Unmute group chat' : '🔕 Mute group chat',
          onPress: async () => {
            try {
              await setGroupChatMuted(groupId, !muted);
              setMuted(!muted);
              showToast(muted ? 'Group chat notifications are back on' : 'Group chat muted – no notifications');
            } catch (error) {
              Alert.alert('Could not save', friendlyError(error));
            }
          },
        },
      ],
    });
  }

  async function runSearch(query: string) {
    const request = ++searchRequest.current;
    setSearch(query);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const list = await searchGroupMessages(groupId, query);
      if (request === searchRequest.current) setResults({ query, list });
    } catch (error) {
      if (request === searchRequest.current) Alert.alert('Search failed', friendlyError(error));
    }
  }

  // Tap a search result: jump to it in the chat (if it's one of the loaded messages).
  function jumpTo(message: GroupMessage) {
    const index = items.findIndex((item) => item.message?.id === message.id);
    setSearch(null);
    setResults(null);
    if (index < 0) {
      showToast(`From ${timeAgo(message.created_at)} ago – too far back to jump to`);
      return;
    }
    setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 250);
  }

  if (group === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Group chat" />
        <EmptyState emoji="💨" title="This group is gone" message="It was deleted, or you're not in it any more." />
      </View>
    );
  }

  // "Seen by": under your newest message, who has read the chat since.
  const myLatest = messages?.find((m) => m.sender_id === userId);
  const seenBy = myLatest
    ? [...reads.entries()].filter(([id, at]) => id !== userId && at >= myLatest.created_at).map(([id]) => nameOf(id))
    : [];
  const memberCount = group?.members.length ?? 0;
  const pinnedMessage = pinnedId ? (messages?.find((m) => m.id === pinnedId) ?? null) : null;
  const openedMedia = viewing && items.some((item) => itemKey(item) === viewing.key) ? viewing.media : null;

  return (
    <View style={styles.fill}>
      <ScreenHeader
        titleContent={
          group ? (
            <Pressable style={styles.headerTitle} onPress={() => router.push(`/groups/${groupId}`)}>
              {group.photo_path ? (
                <Avatar path={group.photo_path} name={group.name} size={32} />
              ) : (
                <GroupFaces members={group.members} size={22} />
              )}
              <View style={styles.headerText}>
                <Text style={styles.headerName} numberOfLines={1}>
                  {group.name}
                </Text>
                <Text style={[styles.headerSub, typing.length > 0 && styles.headerTyping]} numberOfLines={1}>
                  {typing.length > 0
                    ? `${typing.map(nameOf).join(', ')} ${typing.length === 1 ? 'is' : 'are'} typing…`
                    : `${muted ? '🔕 Muted · ' : ''}${memberCount} people`}
                </Text>
              </View>
            </Pressable>
          ) : null
        }
        right={<RoundIconButton icon="ellipsis-horizontal" label="Group chat options" onPress={openGroupMenu} />}
      />

      <ChatInkProvider ink={ink}>
        {/* Under the top bar: keeps everything above the keyboard (KeyboardSafeView: on iPhone it lifts by the
            keyboard's own height; on Android it is the same KeyboardAvoidingView as before, which must sit directly
            under the top bar – not inside another box – or it works out the keyboard's overlap wrong).
            bottomInset: no gap for the home-bar space under the message box. */}
        <KeyboardSafeView style={styles.body} bottomInset={insets.bottom} androidBehavior="padding">
          <ChatBackground id={background.shown} />
          {search !== null ? (
            <View style={styles.searchBar}>
              <Ionicons name="search" size={18} color={colors.textMuted} />
              <TextInput
                value={search}
                onChangeText={runSearch}
                placeholder="Search this chat"
                placeholderTextColor={colors.textMuted}
                autoFocus
                autoCapitalize="none"
                keyboardAppearance={keyboardAppearance}
                selectionColor={colors.accent}
                style={styles.searchInput}
              />
              <Pressable
                onPress={() => {
                  setSearch(null);
                  setResults(null);
                }}
                hitSlop={10}
                accessibilityLabel="Close search">
                <Text style={styles.searchCancel}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          {pinnedMessage && search === null ? (
            <Pressable style={styles.pinned} onPress={() => jumpTo(pinnedMessage)} accessibilityRole="button" accessibilityLabel="Go to the pinned message">
              <Text style={styles.pinnedIcon}>📌</Text>
              <Text style={styles.pinnedText} numberOfLines={1}>
                <Text style={styles.pinnedName}>{pinnedMessage.sender_id === userId ? 'You' : nameOf(pinnedMessage.sender_id)}: </Text>
                {previewOf(pinnedMessage)}
              </Text>
              <Pressable onPress={() => pin(null)} hitSlop={10} accessibilityLabel="Unpin">
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </Pressable>
            </Pressable>
          ) : null}

          <View style={[styles.fill, background.shown ? styles.clear : null]}>
            {search !== null && search.trim() ? (
              <FlatList
                data={results?.query === search ? results.list : []}
                keyExtractor={(m) => m.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                  results?.query === search ? <Text style={styles.searchEmpty}>Nothing found for “{search.trim()}”</Text> : undefined
                }
                renderItem={({ item }) => (
                  <Pressable style={styles.result} onPress={() => jumpTo(item)} accessibilityRole="button">
                    <Text style={styles.resultName}>
                      {item.sender_id === userId ? 'You' : nameOf(item.sender_id)} · {timeAgo(item.created_at)}
                    </Text>
                    <Text style={styles.resultText} numberOfLines={2}>
                      {item.body}
                    </Text>
                  </Pressable>
                )}
              />
            ) : messages === null ? (
              <ActivityIndicator color={colors.accent} style={styles.loading} />
            ) : items.length === 0 ? (
              <View style={[styles.fill, background.shown ? styles.clear : null]}>
                {/* On a chat background the words sit on a soft card, so they're easy to read. */}
                <View style={background.shown ? styles.emptyCard : null}>
                  <EmptyState emoji="💬" title="Say hi to the group!" message="Text, send a photo 📷, a voice note 🎤, or dare everyone 🚩." />
                </View>
              </View>
            ) : (
              <FlatList
                ref={listRef}
                data={items}
                inverted
                keyExtractor={itemKey}
                contentContainerStyle={styles.list}
                keyboardDismissMode="interactive"
                onScrollToIndexFailed={() => showToast('Scroll up a bit and try again')}
                renderItem={({ item: entry, index }) => {
                  if (entry.guess) {
                    // 🕵️ A group Guess Who: no name and no picture of who sent it, in the middle of the chat.
                    const post = entry.guess;
                    return (
                      <GroupGuessCard
                        post={post}
                        people={guesses?.people ?? new Map()}
                        now={now}
                        mediaUrl={urls[post.media_path]}
                        posterUrl={post.poster_path ? urls[post.poster_path] : undefined}
                        overlayUrl={post.overlay_path ? urls[post.overlay_path] : undefined}
                        busy={guessing === post.id}
                        animate={justRevealed.has(post.id)}
                        onGuess={(choice) => guessWho(post, choice)}
                        onOpen={() => setViewing({ key: itemKey(entry), media: post })}
                        onMenu={() => openGuessMenu(post)}
                      />
                    );
                  }
                  const item = entry.message;
                  const mine = item.sender_id === userId;
                  const sender = people.get(item.sender_id);
                  const name = nameOf(item.sender_id);
                  // The list is upside down: the row "after" this one on screen is the one before it in time.
                  // A Guess Who in between ends a run of someone's messages (so the name shows again).
                  const older = items[index + 1];
                  const firstOfRun = !older || !older.message || older.message.sender_id !== item.sender_id;
                  const proofs = item.kind === 'dare' ? proofsByDare.get(item.id) ?? new Set<string>() : null;
                  const myProof = item.kind === 'dare' ? myProofByDare.get(item.id) : undefined;
                  const replied = item.reply_to ? messages.find((m) => m.id === item.reply_to) : null;
                  return (
                    <View style={[styles.row, mine ? styles.right : styles.left]}>
                      {!mine ? (
                        <View style={styles.avatarSlot}>
                          {firstOfRun ? <StoryAvatar person={sender} size={28} /> : null}
                        </View>
                      ) : null}
                      <View style={[styles.bubbleWrap, item.kind === 'dare' && styles.dareWrap, mine ? styles.alignRight : styles.alignLeft]}>
                        {!mine && firstOfRun ? <Text style={[styles.sender, ink]}>{name}</Text> : null}
                        {replied ? (
                          <ReplyQuote name={replied.sender_id === userId ? 'You' : nameOf(replied.sender_id)} text={previewOf(replied)} mine={mine} />
                        ) : null}
                        <Pressable
                          onLongPress={() => openMessageMenu(item)}
                          onPress={item.media_path && item.kind !== 'voice' ? () => setViewing({ key: item.id, media: item }) : undefined}
                          accessibilityRole={item.media_path && item.kind !== 'voice' ? 'button' : undefined}
                          accessibilityLabel={item.media_path && item.kind !== 'voice' ? `Open ${item.media_type === 'video' ? 'video' : 'photo'}` : undefined}
                          style={styles.stretch}>
                          {item.kind === 'sticker' && item.sticker && isKnownSticker(item.sticker) ? (
                            <ChatSticker id={item.sticker} />
                          ) : item.kind === 'text' || item.kind === 'sticker' ? (
                            <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                              <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
                            </View>
                          ) : item.kind === 'voice' ? (
                            <VoiceBubble path={item.media_path} durationMs={item.audio_ms ?? 0} waveform={item.waveform} mine={mine} />
                          ) : item.kind === 'dare' && proofs ? (
                            <View style={[styles.dareCard, proofs.size >= memberCount && memberCount > 0 && styles.dareCardDone]}>
                              <Text style={styles.dareLabel}>
                                🎯 {mine ? 'YOU DARED THE GROUP' : `${name.toUpperCase()} DARED THE GROUP`}
                              </Text>
                              <Text style={styles.dareText}>{item.body}</Text>
                              <Text style={styles.dareNote}>
                                {proofs.size >= memberCount && memberCount > 0
                                  ? '🔥 Everyone did it!'
                                  : proofs.size === 0
                                    ? 'Nobody has done it yet'
                                    : `${proofs.size} of ${memberCount} did it: ${[...proofs].map((id) => (id === userId ? 'you' : nameOf(id))).join(', ')}`}
                              </Text>
                              {myProof && !proofs.has(userId) ? <Text style={styles.dareNote}>{myProofNote(myProof)}</Text> : null}
                              {proofs.has(userId) ? (
                                <Text style={styles.dareDone}>✅ You did it</Text>
                              ) : (
                                <Pressable
                                  onPress={() => openCamera(item.id)}
                                  style={({ pressed }) => [styles.dareButton, pressed && styles.pressed]}
                                  accessibilityRole="button"
                                  accessibilityLabel="Do it and post proof">
                                  <Ionicons name="camera" size={16} color={colors.onAccent} />
                                  <Text style={styles.dareButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                                    Do it · post proof
                                  </Text>
                                </Pressable>
                              )}
                            </View>
                          ) : item.media_path ? (
                            <View>
                              {item.kind === 'proof' ? (
                                <Text style={[styles.proofTag, !proofCounts(item) && (proofOutcome(item) === 'cap' ? styles.proofTagCap : styles.proofTagOpen)]}>
                                  {proofLabel(item)}
                                </Text>
                              ) : null}
                              {item.media_type === 'video' ? (
                                <VideoClip
                                  uri={urls[item.media_path] ?? ''}
                                  posterUri={item.poster_path ? urls[item.poster_path] : null}
                                  overlayUri={item.overlay_path ? urls[item.overlay_path] : null}
                                  playing={false}
                                  muted
                                  style={styles.media}
                                />
                              ) : (
                                <Image source={{ uri: urls[item.media_path] }} style={styles.media} contentFit="cover" transition={150} />
                              )}
                            </View>
                          ) : null}
                        </Pressable>
                    {/* Votes on a proof: the totals, and Legit / Cap for everyone who was in the group when it was
                        posted, except the poster. */}
                        {item.kind === 'proof' && item.proof_legit !== undefined && (!mine || item.proof_legit + (item.proof_cap ?? 0) > 0) ? (
                          <View style={styles.voteRow}>
                            {(item.proof_legit ?? 0) + (item.proof_cap ?? 0) > 0 ? (
                              <Text style={styles.voteTotals}>
                                🔥 {item.proof_legit ?? 0} · 🧢 {item.proof_cap ?? 0}
                              </Text>
                            ) : null}
                        {mine ? null : !canVoteOnProof(item, userId, joinedAt) ? (
                          <Text style={styles.voteNote}>You joined after this was posted, so you can&apos;t vote on it</Text>
                        ) : (
                          ([true, false] as const).map((legit) => {
                                  const chosen = myVotes.get(item.id) === legit;
                                  const busy = busyVotes.has(item.id);
                                  return (
                                    <Pressable
                                      key={legit ? 'legit' : 'cap'}
                                      onPress={() => voteOn(item, legit)}
                                      disabled={busy}
                                      style={({ pressed }) => [styles.voteButton, chosen && styles.voteButtonChosen, (pressed || busy) && styles.pressed]}
                                      accessibilityRole="button"
                                      accessibilityState={{ selected: chosen, disabled: busy }}
                                      accessibilityLabel={
                                        chosen ? `You said ${legit ? 'legit' : 'cap'}. Tap to take your vote back` : legit ? 'Vote legit' : 'Vote cap'
                                      }>
                                      <Text style={[styles.voteText, chosen && styles.voteTextChosen]}>{legit ? 'Legit 🔥' : 'Cap 🧢'}</Text>
                                    </Pressable>
                                  );
                                })
                        )}
                          </View>
                        ) : null}
                        <ReactionChips reactions={reactions.get(item.id)} me={userId} onToggle={(emoji) => react(item, emoji)} />
                        <Text style={[styles.time, ink]}>
                          {pinnedId === item.id ? '📌 ' : ''}
                          {timeAgo(item.created_at)}
                          {mine && item.id === myLatest?.id && seenBy.length > 0
                            ? ` · 👁 Seen by ${seenBy.length === memberCount - 1 ? 'everyone' : seenBy.join(', ')}`
                            : ''}
                        </Text>
                      </View>
                    </View>
                  );
                }}
              />
            )}

            {replyTo ? (
              <View style={styles.replyBar}>
                <View style={styles.replyBarText}>
                  <Text style={styles.replyBarName} numberOfLines={1}>
                    ↩ Replying to {replyTo.sender_id === userId ? 'yourself' : nameOf(replyTo.sender_id)}
                  </Text>
                  <Text style={styles.replyBarBody} numberOfLines={1}>
                    {previewOf(replyTo)}
                  </Text>
                </View>
                <Pressable onPress={() => setReplyTo(null)} hitSlop={10} accessibilityLabel="Cancel reply">
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </Pressable>
              </View>
            ) : null}
            <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
              <IconButton icon="camera" label="Send a photo or video" background={colors.accent} color={colors.onAccent} onPress={() => openCamera()} />
              <IconButton icon="flag" label="Dare the group" background={colors.card} color={colors.pink} onPress={() => setDareOpen(true)} />
              <IconButton icon="happy" label="Send a sticker" background={colors.card} color={colors.yellow} onPress={() => setStickersOpen(true)} />
              <TextInput
                value={text}
                onChangeText={(value) => {
                  draft.current = value;
                  setText(value);
                  onTextChange(value);
                }}
                placeholder="Message the group"
                placeholderTextColor={colors.textFaint}
                keyboardAppearance={keyboardAppearance}
                selectionColor={colors.accent}
                multiline
                maxLength={2000}
                style={styles.input}
              />
              {text.trim() || !Audio ? (
                <IconButton icon="arrow-up" label="Send" background={text.trim() ? colors.blue : colors.card} onPress={send} disabled={sending} />
              ) : (
                <MicButton onRecorded={sendVoiceNote} onHint={showToast} />
              )}
            </View>
          </View>
        </KeyboardSafeView>
      </ChatInkProvider>
      <ChatBackgroundPicker
        visible={backgroundOpen}
        current={background.picked}
        plus={background.plus}
        onPick={background.choose}
        onClose={() => setBackgroundOpen(false)}
      />
      <StickerPicker
        visible={stickersOpen}
        onClose={() => setStickersOpen(false)}
        onPickEmoji={sendEmoji}
        onPickWord={(word) => sendStickerMessage(wordStickerId(word))}
        onPickSpecial={sendStickerMessage}
      />
      <DareComposer visible={dareOpen} friendName="the group" onClose={() => setDareOpen(false)} onSend={sendDare} />
      <MessageActions
        visible={menuFor !== null}
        myReaction={menuFor ? (reactions.get(menuFor.message.id)?.find((r) => r.user_id === userId)?.emoji ?? null) : null}
        onReact={(emoji) => menuFor && react(menuFor.message, emoji)}
        actions={menuFor?.actions ?? []}
        onClose={() => setMenuFor(null)}
      />
      <Modal visible={openedMedia !== null} animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={styles.mediaViewer}>
          {openedMedia?.media_path && urls[openedMedia.media_path] ? (
            openedMedia.media_type === 'video' ? (
              <VideoClip
                uri={urls[openedMedia.media_path]}
                posterUri={openedMedia.poster_path ? urls[openedMedia.poster_path] : null}
                overlayUri={openedMedia.overlay_path ? urls[openedMedia.overlay_path] : null}
                playing
                muted={false}
                contentFit="contain"
                style={styles.fill}
              />
            ) : (
              <ZoomableImage uri={urls[openedMedia.media_path]} contentFit="contain" style={styles.fill} />
            )
          ) : <ActivityIndicator color={colors.white} />}
          <SafeEdge edge="top" style={styles.mediaClose}>
            <Button title="Close media" variant="secondary" small onPress={() => setViewing(null)} />
          </SafeEdge>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  mediaViewer: { flex: 1, backgroundColor: colors.black },
  mediaClose: { position: 'absolute', top: 0, right: 0, padding: space.lg },
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  // Everything under the top bar. A chat background fills this space, behind the messages.
  body: {
    flex: 1,
  },
  // See-through, so the chat background shows.
  clear: {
    backgroundColor: 'transparent',
  },
  emptyCard: {
    marginHorizontal: space.lg,
    marginTop: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.bg + 'E6',
  },
  loading: {
    marginTop: space.xl,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 240,
  },
  headerText: {
    flexShrink: 1,
  },
  headerName: {
    ...font.body,
    fontWeight: '900',
  },
  headerSub: {
    ...font.small,
  },
  headerTyping: {
    color: colors.accent,
    fontWeight: '700',
  },
  pinned: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  pinnedIcon: {
    fontSize: 16,
  },
  pinnedText: {
    ...font.small,
    flex: 1,
    color: colors.text,
  },
  pinnedName: {
    fontWeight: '800',
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  replyBarText: {
    flex: 1,
  },
  replyBarName: {
    ...font.small,
    fontWeight: '800',
    color: colors.accent,
  },
  replyBarBody: {
    ...font.small,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  searchInput: {
    flex: 1,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: 16,
  },
  searchCancel: {
    ...font.small,
    color: colors.accent,
    fontWeight: '800',
  },
  searchEmpty: {
    ...font.small,
    textAlign: 'center',
    marginTop: space.lg,
  },
  result: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    gap: 2,
  },
  resultName: {
    ...font.small,
    fontWeight: '800',
  },
  resultText: {
    ...font.body,
  },
  list: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
  },
  right: {
    justifyContent: 'flex-end',
  },
  left: {
    justifyContent: 'flex-start',
  },
  avatarSlot: {
    width: 28,
  },
  bubbleWrap: {
    maxWidth: '78%',
    gap: 3,
  },
  dareWrap: {
    width: '78%',
  },
  stretch: {
    alignSelf: 'stretch',
  },
  alignRight: {
    alignItems: 'flex-end',
  },
  alignLeft: {
    alignItems: 'flex-start',
  },
  sender: {
    ...font.small,
    fontWeight: '800',
    marginLeft: space.sm,
  },
  bubble: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
  },
  bubbleMine: {
    backgroundColor: colors.purple,
    borderBottomRightRadius: 6,
  },
  bubbleTheirs: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    ...font.body,
    lineHeight: 22,
  },
  bubbleTextMine: {
    color: colors.white,
  },
  media: {
    width: 220,
    height: 300,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  proofTag: {
    ...font.small,
    color: colors.green,
    fontWeight: '900',
    marginBottom: 4,
  },
  proofTagOpen: {
    color: colors.textMuted,
  },
  proofTagCap: {
    color: colors.pink,
  },
  voteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  voteTotals: {
    ...font.small,
    fontWeight: '800',
  },
  voteButton: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  voteButtonChosen: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  voteText: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
  voteTextChosen: {
    color: colors.onAccent,
  },
  voteNote: {
    ...font.small,
    color: colors.textMuted,
  },
  dareCard: {
    alignSelf: 'stretch',
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.pink,
    backgroundColor: colors.card,
    padding: space.md,
    gap: space.sm,
  },
  dareCardDone: {
    borderColor: colors.green,
  },
  dareLabel: {
    color: colors.pink,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  dareText: {
    ...font.body,
    fontWeight: '700',
  },
  dareNote: {
    ...font.small,
    lineHeight: 18,
  },
  dareDone: {
    ...font.small,
    color: colors.green,
    fontWeight: '900',
  },
  dareButton: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: 11,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  dareButtonText: {
    flexShrink: 1,
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.8,
  },
  time: {
    ...font.small,
    fontSize: 11,
    marginHorizontal: space.sm,
  },
  inputBar: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 16,
  },
});
