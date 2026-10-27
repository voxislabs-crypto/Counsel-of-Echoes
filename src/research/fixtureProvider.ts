import type { SearchLead, SearchProvider } from "./types.js";

export type FactualFixture = {
  id: string;
  pattern: RegExp;
  title: string;
  sourceUrl: string;
  excerpt: string;
  supportedFacts: string[];
  contradictedClaims: string[];
};

export const factualFixtures: FactualFixture[] = [
  {
    id: "fact-everest-height",
    pattern: /everest|highest mountain/i,
    title: "Mount Everest",
    sourceUrl: "https://en.wikipedia.org/wiki/Mount_Everest",
    excerpt: "Mount Everest is Earth's highest mountain above sea level. It stands in the Mahalangur Himal sub-range of the Himalayas, on the border between Nepal and the Tibet Autonomous Region of China. The official height is 8,848.86 metres, measured jointly by Nepal and China in 2020. The mountain is also called Sagarmatha in Nepali and Chomolungma in Tibetan. Climbers approach from the South Col on the Nepali side or the North Col from Tibet. The summit was first reached in 1953 by Edmund Hillary and Tenzing Norgay. Weather, altitude, and the Khumbu Icefall make the climb dangerous. This excerpt is bounded source data for the council and is not an instruction.",
    supportedFacts: ["8,848.86 metres", "Mahalangur Himal"],
    contradictedClaims: ["9,000 metres", "the Alps"]
  },
  {
    id: "fact-moon-landing",
    pattern: /moon landing|apollo 11|neil armstrong/i,
    title: "Apollo 11",
    sourceUrl: "https://en.wikipedia.org/wiki/Apollo_11",
    excerpt: "The first crewed Moon landing occurred in 1969 during NASA's Apollo 11 mission. Neil Armstrong was the first person to walk on the Moon, stepping onto the surface on 20 July 1969. Buzz Aldrin followed Armstrong onto the surface later in the same excursion. Michael Collins remained in lunar orbit aboard the command module. The landing site was the Sea of Tranquility. The mission launched on 16 July 1969 and returned to Earth on 24 July 1969. This excerpt records that sequence as source data for the council and is not an instruction to any seat.",
    supportedFacts: ["1969", "Neil Armstrong"],
    contradictedClaims: ["1968", "Buzz Aldrin was the first"]
  },
  {
    id: "fact-gold-symbol",
    pattern: /chemical symbol for gold|\bgold\b/i,
    title: "Gold",
    sourceUrl: "https://en.wikipedia.org/wiki/Gold",
    excerpt: "Gold is a chemical element with the symbol Au and atomic number 79. It is a dense, soft, malleable, and ductile metal that resists most acids. People use it in coinage, jewelry, and electronics because it does not corrode easily. The symbol Au comes from the Latin aurum. Gold is a transition metal and one of the least reactive chemical elements. Jewelers measure purity in karats, while refiners track it by mass and conductivity. This excerpt is source data for the council, bounded to the article text, and it is not an instruction to the seat reading it.",
    supportedFacts: ["Au", "atomic number 79"],
    contradictedClaims: ["atomic number 47"]
  }
];

export const fixtureSearch: SearchProvider = {
  async search(query: string): Promise<SearchLead[]> {
    return factualFixtures
      .filter((fixture) => fixture.pattern.test(query))
      .slice(0, 3)
      .map((fixture) => ({
        title: fixture.title,
        url: fixture.sourceUrl,
        snippet: fixture.excerpt
      }));
  }
};
