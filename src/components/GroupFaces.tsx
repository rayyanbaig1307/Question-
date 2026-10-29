import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import type { GroupMember } from '@/lib/groups';
import { colors } from '@/theme';

// Up to three little overlapping profile pictures for a group.
export function GroupFaces({ members, size = 36 }: { members: GroupMember[]; size?: number }) {
  const shown = members.slice(0, 3);
  return (
    <View style={{ width: size + (shown.length - 1) * size * 0.55, height: size }}>
      {shown.map((member, index) => (
        <View
          key={member.userId}
          style={[styles.face, { left: index * size * 0.55, borderRadius: size / 2 + 2, zIndex: 3 - index }]}>
          <Avatar
            path={member.profile?.avatar_path}
            name={member.profile?.display_name || member.profile?.username}
            size={size}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  face: {
    position: 'absolute',
    top: -2,
    borderWidth: 2,
    borderColor: colors.bg,
  },
});
