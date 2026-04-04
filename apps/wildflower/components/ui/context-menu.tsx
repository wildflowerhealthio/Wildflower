import { type JSX, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import { useThemeColor } from '@/hooks/use-theme-color'

export type ContextMenuAction = {
  key: string
  label: string
  systemImage?: string
  role?: 'default' | 'destructive'
}

export default function ContextMenuWrapper({
  actions,
  onAction,
  children,
}: {
  actions: ContextMenuAction[]
  onAction: (actionKey: string) => void
  children?: React.ReactNode
}): JSX.Element {
  const [menuVisible, setMenuVisible] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<View>(null)
  const tintColor = useThemeColor({}, 'tint')

  if (actions.length === 0) {
    return <>{children}</>
  }

  return (
    <View ref={triggerRef} onStartShouldSetResponder={() => false}>
      <Pressable
        onLongPress={() => {
          triggerRef.current?.measure((_x, _y, _width, height, pageX, pageY) => {
            setMenuPosition({ x: pageX + 8, y: pageY + height })
            setMenuVisible(true)
          })
        }}
        delayLongPress={500}
      >
        {children}
      </Pressable>
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenuVisible(false)}>
          <View style={[styles.menu, { top: menuPosition.y, left: menuPosition.x }]}>
            {actions.map((action, index) => (
              <Pressable
                key={action.key}
                style={({ pressed }) => [
                  styles.menuItem,
                  index < actions.length - 1 && styles.menuItemBorder,
                  pressed && { backgroundColor: '#f0f0f0' },
                ]}
                onPress={() => {
                  setMenuVisible(false)
                  onAction(action.key)
                }}
              >
                <Text
                  style={[
                    styles.menuItemText,
                    action.role === 'destructive' ? styles.destructiveText : { color: tintColor },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  menu: {
    position: 'absolute',
    minWidth: 160,
    backgroundColor: '#fff',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
    overflow: 'hidden',
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  menuItemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  menuItemText: {
    fontSize: 16,
  },
  destructiveText: {
    color: '#FF3B30',
  },
})
