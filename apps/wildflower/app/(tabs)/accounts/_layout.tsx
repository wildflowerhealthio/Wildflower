import { type Href, useRouter } from 'expo-router'
import { ThemedButton } from '@/components/themed-button'

import { nanoid } from '@livestore/livestore'
import React from 'react'

import { DateTime } from 'effect'
import { accounts$ } from 'fhir-r4-livestore/queries'
import { events } from 'fhir-r4-livestore/schema'
import ItemList from '@/components/ui/item-list'
import { useAppStore } from '../../../livestore/store'

export default function AccountList(): React.JSX.Element {
  const router = useRouter()

  const store = useAppStore()
  const accounts = store.useQuery(accounts$)

  const accountAdded = (): void =>
    store.commit(
      events.accountAdded({
        id: nanoid(),
        name: `New ${new Date().toLocaleString()}`,
        addedAt: DateTime.unsafeNow(),
      })
    )

  return (
    // <ParallaxScrollView
    //   headerBackgroundColor={{ light: '#D0D0D0', unspecified: '#D0D0D0', dark: '#353636' }}
    // >
    //   <ThemedView style={styles.titleContainer}>
    //     <ThemedText
    //       type="title"
    //       style={{
    //         fontFamily: Fonts.rounded,
    //       }}
    //     >
    //       Sources
    //     </ThemedText>
    //   </ThemedView>
    //   <ThemedText>All connected health data sources</ThemedText>
    //   {accounts.map((account) => (
    //     <ThemedView key={account.id} style={{ padding: 10, borderBottomWidth: 1 }}>
    //       <ThemedText>{account.name}</ThemedText>
    //       <ThemedText>{account.addedAt?.toLocaleString()}</ThemedText>
    //     </ThemedView>
    //   ))}
    //   <ThemedButton
    //     title="Add Source"
    //     onPress={() => {
    //       accountAdded()
    //       router.navigate('/add-source-modal')
    //     }}
    //   />
    // </ParallaxScrollView>
    <>
      <ItemList
        title="Accounts"
        onDelete={() => {}}
        items={accounts.map((account) => ({
          id: account.id,
          title: account.name,
          destination: `./` satisfies Href, // `/accounts/${account.id}`
          subtitle: DateTime.formatLocal(account.addedAt),
        }))}
      />
      <ThemedButton
        title="Add Source"
        onPress={() => {
          accountAdded()
          router.navigate('/add-source-modal')
        }}
      />
    </>
  )
}
