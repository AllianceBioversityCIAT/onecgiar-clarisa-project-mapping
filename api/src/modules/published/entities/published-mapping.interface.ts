/**
 * Shape of a single mapping entry stored as JSON inside a PublishedProject row.
 * This is NOT a database entity — it describes the embedded JSON structure.
 */
export interface PublishedMappingData {
  programName: string;
  programCode: string;
  allocationPercentage: number;
  complementarityRating: string | null;
  efficiencyRating: string | null;
}
