/** One case of a contract suite. Framework-free: register each with your runner (`test(c.name, c.run)`). */
export interface ContractCase {
  name: string;
  run: () => Promise<void>;
}
