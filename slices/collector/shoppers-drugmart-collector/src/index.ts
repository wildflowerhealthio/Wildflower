// Shoppers Drug Mart "mypharmacy" collector. The full collector surface: the
// `ShoppersDrugMartCollectorDescriptor` (config, login-and-pause-for-2FA
// scraping plan, `fhir-r4/clients`' shared persist sink, display)
// `collector-registry` assembles, the profile/prescription entities it
// recognizes (which synthesize FHIR R4 Patient / MedicationRequest /
// MedicationDispense from the portal's bespoke JSON), and the
// `ShoppersDrugMartConfigForm` `collector-react` registers.

export * from './config.ts'
export * from './shoppers-drugmart-config-form.tsx'
export * from './entities/profile-entity.ts'
export * from './entities/prescription-entity.ts'
export * as Shoppers from './shoppers.ts'
