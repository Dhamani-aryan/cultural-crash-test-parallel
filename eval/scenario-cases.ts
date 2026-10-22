/** Realistic, user-supplied launch prompts used for intake and end-to-end acceptance checks. */
export interface ScenarioCase {
  id: string;
  title: string;
  prompt: string;
  /** Simulate the user handing over genuinely missing details after the intake asks. */
  delegateMissing?: boolean;
}

export const SCENARIOS: ScenarioCase[] = [
  {
    id: "streetwear-new-york",
    title: "Streetwear — New York",
    prompt:
      "We're a streetwear brand called Rookline Supply, targeting people in their 20s and 30s who are into independent fashion, hip-hop, and skate culture. We're planning a pop-up on the Lower East Side with live screen printing, clothing customization, and a performance we're hoping to arrange with Princess Nokia. We want the launch to feel connected to New York's creative scene rather than like another clothing brand throwing a party.",
  },
  {
    id: "speakeasy-new-york",
    title: "Instagram-secret speakeasy — New York",
    prompt:
      "We're opening a hidden speakeasy in New York and want to make discovering it part of the experience. Our plan is to post cryptic Instagram Reels containing riddles, with each solution revealing a clue to the bar's location. We're targeting young professionals who enjoy cocktails, underground music, and exclusive nightlife experiences. We also want a distinctive music and interior concept that makes the place worth discovering and sharing.",
  },
  {
    id: "luxury-handbags-london",
    title: "Luxury handbags — London",
    prompt:
      "We're a British luxury handbag brand called Wren & Wold, targeting women in their 30s and 40s who appreciate craftsmanship, contemporary art, and understated fashion. We're planning an intimate gallery launch in Marylebone featuring our collection, a British design exhibition, and potentially a performance by Little Simz. We want the evening to feel sophisticated and culturally relevant without becoming another celebrity-led luxury event.",
  },
  {
    id: "non-alcoholic-london",
    title: "Non-alcoholic aperitivo — London",
    prompt:
      "We're launching a premium non-alcoholic aperitivo brand in London, targeting people who enjoy nightlife, music, food, and creative experiences. We're considering an event in Dalston with a listening-party concept, a curated drinks menu, a food collaboration, and possibly a live performance by Joy Crookes. We want the brand to feel like a natural part of London's nightlife culture, not a wellness product being marketed at a party.",
  },
  {
    id: "eyewear-tokyo",
    title: "Premium eyewear — Tokyo",
    prompt:
      "We're a premium eyewear brand launching in Tokyo, with minimalist titanium frames aimed at designers, architects, and fashion-conscious professionals. We're planning a showroom launch in Omotesando with an exhibition about contemporary Japanese design and an experimental music session, potentially featuring Wednesday Campanella. We want to know whether the musical direction fits our product and audience or whether a different combination would make the launch more compelling.",
  },
  {
    id: "upcycled-denim-tokyo",
    title: "Upcycled denim — Tokyo",
    prompt:
      "We're an upcycled denim brand launching in Tokyo, targeting young people interested in vintage clothing, independent music, and DIY fashion. We're considering a pop-up in Shimokitazawa with garment-customization workshops, reconstructed denim displays, and a performance by Haru Nemuri. We want to connect with the right local creative community without mixing unrelated fashion and music references just because they're popular.",
  },
  {
    id: "streetwear-mumbai",
    title: "Streetwear and Indian hip-hop — Mumbai",
    prompt:
      "We're launching a contemporary streetwear label in Mumbai, targeting young adults who follow Indian hip-hop, sneakers, and independent fashion. We're planning a pop-up in Bandra with graffiti-inspired artwork, sneaker customization, and a performance we're hoping to arrange with DIVINE. We want the launch to connect with Mumbai's street culture while building a distinctive brand identity, rather than simply relying on a popular rapper to attract attention.",
  },
  {
    id: "accessories-mumbai",
    title: "Women's accessories and contemporary art — Mumbai",
    prompt:
      "We're a premium women's accessories brand launching a collection of sculptural jewelry and handbags in Mumbai. We're considering a pop-up at Jio World Plaza, with a contemporary art installation, a styling experience, and an intimate musical performance we're exploring with Ankur Tewari. Our audience is women in their late 20s to early 40s who appreciate design, fashion, and cultural experiences. We want the launch to balance Mumbai's luxury retail environment with a more distinctive creative identity.",
  },
  {
    id: "jewelry-paris",
    title: "Sculptural jewelry — Paris",
    prompt:
      "We're launching a contemporary jewelry brand in Paris, targeting women interested in art, independent designers, and expressive fashion. We're planning a gallery event in Le Marais with an exhibition exploring form and materials, editorial photography, and potentially a performance by Yseult. We want to make the jewelry feel connected to the music and artistic direction, rather than creating an impressive event where the products become an afterthought.",
  },
  {
    id: "streetwear-sao-paulo",
    title: "Streetwear and urban culture — São Paulo",
    prompt:
      "We're launching an independent streetwear label in São Paulo, targeting young adults interested in Brazilian hip-hop, sneakers, vintage clothing, and urban art. We're considering a pop-up around the city's central streetwear scene, with sneaker restoration, graffiti-inspired installations, and a live performance we're hoping to arrange with Emicida. We want to connect with the city's creative communities without using generic streetwear references that could work anywhere in the world.",
  },
  {
    id: "sneakers-madrid",
    title: "Lifestyle sneakers — Madrid",
    prompt:
      "We're launching a lifestyle sneaker brand in Madrid, targeting young adults who follow streetwear, skate culture, Spanish music, and contemporary design. We're planning a launch around Malasaña with a customization booth, a small skateboarding activation, and a live set we're considering with C. Tangana. We want to understand whether these elements fit together culturally or whether a different combination of local music, fashion, and creative communities would give the brand a stronger identity.",
  },
  {
    id: "cocktail-bar-mexico-city",
    title: "Hidden cocktail bar — Mexico City",
    delegateMissing: true,
    prompt:
      "We're opening a hidden cocktail bar in Mexico City and want to turn finding it into an experience. We'll publish Instagram Reels containing visual clues and riddles, leading people through a series of discoveries before revealing the entrance in the Juárez neighborhood. Inside, we're considering a distinctive cocktail menu, intimate live music, and an unconventional interior inspired by contemporary art and local nightlife. We want the concept to feel genuinely connected to the city's creative culture, not like a generic secret bar.",
  },
  {
    id: "headphones-toronto",
    title: "Premium headphones — Toronto",
    prompt:
      "We're launching premium headphones in Toronto, targeting musicians, designers, and people who care about audio quality and independent music. We're planning a listening experience around Queen Street West, with curated tracks, an interactive sound installation, and a performance we're considering with Charlotte Day Wilson. We want the launch to connect the product with Toronto's creative scene rather than feeling like a standard technology event with a musician added at the end.",
  },
  {
    id: "sun-care-sydney",
    title: "Outdoor sun-care — Sydney",
    prompt:
      "We're launching a premium sun-care brand in Sydney, targeting people who surf, run, hike, and spend time outdoors. We're planning a sunrise gathering around Bondi with product trials, surf photography, a community activity, and an evening music session. We want to connect the brand with Sydney's outdoor lifestyle while avoiding the usual beach-party aesthetic. Help us find a cultural direction that feels authentic to the audience and gives the launch a distinctive identity.",
  },
  {
    id: "fragrance-berlin",
    title: "Fragrance and electronic music — Berlin",
    prompt:
      "We're launching an independent fragrance brand in Berlin, targeting people interested in experimental design, fashion, electronic music, and nightlife. We're considering an installation in Kreuzberg that explores the relationship between scent, lighting, and sound, followed by a late-night electronic music event. We want to capture some of Berlin's creative energy without relying on predictable techno-club imagery. We're open to exploring different artists, cultural references, and formats that would make the launch feel distinctive.",
  },
];
