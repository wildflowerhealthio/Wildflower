/** A common over-the-counter active ingredient to check the patient's medications against. */
interface OtcDrug {
  /** The active ingredient, as DDInter names it (matched fuzzily, so salts are fine). */
  readonly name: string
  /** Familiar Canadian brand names, for the UI. */
  readonly brands?: string | undefined
}

/**
 * Curated common Canadian OTC actives: pain and fever, allergy and cold,
 * stomach, sleep and supplements. Each is matched against the DDInter catalog
 * once per report; an entry DDInter does not list simply yields no rows.
 */
const otcDrugs: readonly OtcDrug[] = [
  // Pain / fever / anti-inflammatory
  { name: 'Acetaminophen', brands: 'Tylenol' },
  { name: 'Ibuprofen', brands: 'Advil, Motrin' },
  { name: 'Naproxen', brands: 'Aleve' },
  { name: 'Aspirin', brands: 'Aspirin, ASA' },
  { name: 'Diclofenac', brands: 'Voltaren Emulgel' },
  // Allergy
  { name: 'Diphenhydramine', brands: 'Benadryl, Nytol' },
  { name: 'Loratadine', brands: 'Claritin' },
  { name: 'Cetirizine', brands: 'Reactine' },
  { name: 'Fexofenadine', brands: 'Allegra' },
  { name: 'Chlorpheniramine', brands: 'Chlor-Tripolon' },
  // Cold / cough / decongestant
  { name: 'Pseudoephedrine', brands: 'Sudafed' },
  { name: 'Phenylephrine', brands: 'Sudafed PE' },
  { name: 'Dextromethorphan', brands: 'Benylin DM, Delsym' },
  { name: 'Guaifenesin', brands: 'Mucinex' },
  { name: 'Oxymetazoline', brands: 'Dristan, Otrivin' },
  { name: 'Xylometazoline', brands: 'Otrivin' },
  // Stomach / bowel
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
  // Sleep / stress
  { name: 'Melatonin' },
  { name: 'Doxylamine', brands: 'Unisom' },
  // Smoking cessation
  { name: 'Nicotine', brands: 'Nicorette, Nicoderm' },
  // Supplements / natural health products
  { name: "St. John's Wort" },
  { name: 'Vitamin D' },
  { name: 'Vitamin C' },
  { name: 'Vitamin E' },
  { name: 'Calcium' },
  { name: 'Magnesium' },
  { name: 'Iron' },
  { name: 'Zinc' },
  { name: 'Folic acid' },
  { name: 'Omega-3 fatty acids', brands: 'fish oil' },
  { name: 'Ginkgo' },
  { name: 'Glucosamine' },
  // Topical / other
  { name: 'Hydrocortisone', brands: 'Cortate' },
  { name: 'Minoxidil', brands: 'Rogaine' },
  { name: 'Miconazole', brands: 'Micozole, Monistat' },
  { name: 'Clotrimazole', brands: 'Canesten' },
]

export { type OtcDrug, otcDrugs }
