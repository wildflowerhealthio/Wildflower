import { NativeTabs } from 'expo-router/unstable-native-tabs'
import React, { type JSX } from 'react'

export default function TabLayout(): JSX.Element {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house.fill" md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="records">
        <NativeTabs.Trigger.Label>Records</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="folder.fill" md="folder" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="accounts">
        <NativeTabs.Trigger.Label>Accounts</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.crop.circle.fill" md="account_circle" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
