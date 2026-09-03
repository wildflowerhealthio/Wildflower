/** A common over-the-counter active ingredient to check the patient's medications against. */
interface OtcDrug {
  /** The active ingredient, as DDInter names it (matched fuzzily, so salts are fine). */
  readonly name: string
  /** Familiar Canadian brand names, for the UI. */
  readonly brands?: string | undefined
}

/** A shelf of the pharmacy: the OTC actives a patient would look for together. */
interface OtcCategory {
  /** Patient-facing label, e.g. `"Stomach and bowel"`. */
  readonly name: string
  readonly drugs: readonly OtcDrug[]
}

/**
 * Curated common Canadian OTC actives, by category. Each active is matched
 * against the DDInter catalog once per report; an entry DDInter does not list
 * simply yields no rows, and a category none of whose entries yield rows is
 * left out of the report.
 */
const otcCategories: readonly OtcCategory[] = [
  {
    name: 'Pain, fever and inflammation',
    drugs: [
      { name: 'Acetaminophen', brands: 'Tylenol' },
      { name: 'Ibuprofen', brands: 'Advil, Motrin' },
      { name: 'Naproxen', brands: 'Aleve' },
      { name: 'Acetylsalicylic acid', brands: 'Aspirin, ASA' },
      { name: 'Diclofenac', brands: 'Voltaren Emulgel' },
    ],
  },
  {
    name: 'Allergy',
    drugs: [
      { name: 'Diphenhydramine', brands: 'Benadryl, Nytol' },
      { name: 'Loratadine', brands: 'Claritin' },
      { name: 'Cetirizine', brands: 'Reactine' },
      { name: 'Fexofenadine', brands: 'Allegra' },
      { name: 'Chlorpheniramine', brands: 'Chlor-Tripolon' },
    ],
  },
  {
    name: 'Cough, cold and decongestants',
    drugs: [
      { name: 'Pseudoephedrine', brands: 'Sudafed' },
      { name: 'Phenylephrine', brands: 'Sudafed PE' },
      { name: 'Dextromethorphan', brands: 'Benylin DM, Delsym' },
      { name: 'Guaifenesin', brands: 'Mucinex' },
      { name: 'Oxymetazoline', brands: 'Dristan, Otrivin' },
      { name: 'Xylometazoline', brands: 'Otrivin' },
    ],
  },
  {
    name: 'Stomach and bowel',
    drugs: [
      { name: 'Omeprazole', brands: 'Olex' },
      { name: 'Esomeprazole', brands: 'Nexium 24HR' },
      { name: 'Famotidine', brands: 'Pepcid AC' },
      { name: 'Ranitidine', brands: 'Zantac' },
      { name: 'Calcium carbonate', brands: 'Tums' },
      { name: 'Magnesium hydroxide', brands: 'Milk of Magnesia' },
      { name: 'Aluminum hydroxide', brands: 'Maalox' },
      { name: 'Bismuth subsalicylate', brands: 'Pepto-Bismol' },
      { name: 'Loperamide', brands: 'Imodium' },
      { name: 'Dimenhydrinate', brands: 'Gravol' },
      { name: 'Docusate', brands: 'Colace' },
      { name: 'Sennosides', brands: 'Senokot' },
      { name: 'Bisacodyl', brands: 'Dulcolax' },
      { name: 'Polyethylene glycol', brands: 'RestoraLAX' },
      { name: 'Simethicone', brands: 'Ovol, Gas-X' },
    ],
  },
  {
    name: 'Sleep and stress',
    drugs: [{ name: 'Melatonin' }, { name: 'Doxylamine', brands: 'Unisom' }],
  },
  {
    name: 'Smoking cessation',
    drugs: [{ name: 'Nicotine', brands: 'Nicorette, Nicoderm' }],
  },
  {
    name: 'Supplements and natural health products',
    drugs: [
      { name: "St. John's Wort" },
      { name: 'Vitamin A' },
      { name: 'Vitamin D' },
      { name: 'Ascorbic acid', brands: 'Vitamin C' },
      { name: 'Vitamin E' },
      { name: 'Niacin' },
      { name: 'Calcium' },
      { name: 'Magnesium' },
      { name: 'Iron' },
      { name: 'Zinc' },
      { name: 'Folic acid' },
      { name: 'Omega-3 fatty acids', brands: 'fish oil' },
      { name: 'Ginkgo' },
      { name: 'Glucosamine' },
      { name: 'Valerian' },
      { name: 'Echinacea' },
      { name: 'Licorice' },
      { name: 'Garlic' },
      { name: 'Ginger' },
      { name: 'Kava' },
      { name: 'Goldenseal' },
    ],
  },
  {
    name: 'Topical and other',
    drugs: [
      { name: 'Hydrocortisone', brands: 'Cortate' },
      { name: 'Minoxidil', brands: 'Rogaine' },
      { name: 'Miconazole', brands: 'Micozole, Monistat' },
      { name: 'Clotrimazole', brands: 'Canesten' },
      { name: 'Benzocaine', brands: 'Anbesol, Orajel' },
      { name: 'Salicylic acid', brands: 'Compound W' },
    ],
  },
]

export { type OtcCategory, otcCategories, type OtcDrug }
