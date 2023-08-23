import { AbiCoder, keccak256, Signer, toUtf8Bytes } from 'ethers';
import { EAS } from '../eas';
import { getOffchainUID, ZERO_BYTES32 } from '../utils';
import { EIP712_NAME } from './delegated';
import {
  DomainTypedData,
  EIP712MessageTypes,
  EIP712Params,
  EIP712Response,
  PartialTypedDataConfig,
  TypedData,
  TypedDataHandler
} from './typed-data-handler';

export { EIP712Request, PartialTypedDataConfig, EIP712MessageTypes } from './typed-data-handler';

interface OffchainAttestationType {
  domainName: string;
  primaryType: string;
  types: TypedData[];
}

export const OFFCHAIN_ATTESTATION_VERSION = 1;
const LEGACY_OFFCHAIN_ATTESTATION_VERSION = 0;

export const OFFCHAIN_ATTESTATION_TYPES: Record<number, OffchainAttestationType> = {
  0: {
    domainName: 'EAS Attestation',
    primaryType: 'Attestation',
    types: [
      { name: 'schema', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'time', type: 'uint64' },
      { name: 'expirationTime', type: 'uint64' },
      { name: 'revocable', type: 'bool' },
      { name: 'refUID', type: 'bytes32' },
      { name: 'data', type: 'bytes' }
    ]
  },
  1: {
    domainName: 'EAS Attestation',
    primaryType: 'Attest',
    types: [
      { name: 'version', type: 'uint16' },
      { name: 'schema', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'time', type: 'uint64' },
      { name: 'expirationTime', type: 'uint64' },
      { name: 'revocable', type: 'bool' },
      { name: 'refUID', type: 'bytes32' },
      { name: 'data', type: 'bytes' }
    ]
  }
};

export type OffchainAttestationParams = {
  version: number;
  schema: string;
  recipient: string;
  time: bigint;
  expirationTime: bigint;
  revocable: boolean;
  refUID: string;
  data: string;
} & Partial<EIP712Params>;

export type OffchainAttestationOptions = {
  verifyOnchain: boolean;
};

const DEFAULT_OFFCHAIN_ATTESTATION_OPTIONS: OffchainAttestationOptions = {
  verifyOnchain: false
};

export interface SignedOffchainAttestation extends EIP712Response<EIP712MessageTypes, OffchainAttestationParams> {
  uid: string;
}

export class Offchain extends TypedDataHandler {
  public readonly version: number;
  private readonly type: OffchainAttestationType;
  private readonly eas: EAS;

  constructor(config: PartialTypedDataConfig, version: number, eas: EAS) {
    if (version > OFFCHAIN_ATTESTATION_VERSION) {
      throw new Error('Unsupported version');
    }

    super({ ...config, name: EIP712_NAME });

    this.version = version;
    this.type = OFFCHAIN_ATTESTATION_TYPES[this.version];
    this.eas = eas;
  }

  public getDomainSeparator() {
    return keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes32', 'uint256', 'address'],
        [
          keccak256(toUtf8Bytes(this.type.domainName)),
          keccak256(toUtf8Bytes(this.config.version)),
          this.config.chainId,
          this.config.address
        ]
      )
    );
  }

  public getDomainTypedData(): DomainTypedData {
    return {
      name: this.type.domainName,
      version: this.config.version,
      chainId: this.config.chainId,
      verifyingContract: this.config.address
    };
  }

  public async signOffchainAttestation(
    params: OffchainAttestationParams,
    signer: Signer,
    options?: OffchainAttestationOptions
  ): Promise<SignedOffchainAttestation> {
    const uid = Offchain.getOffchainUID(params);

    const signedRequest = await this.signTypedDataRequest<EIP712MessageTypes, OffchainAttestationParams>(
      params,
      {
        domain: this.getDomainTypedData(),
        primaryType: this.type.primaryType,
        message: params,
        types: {
          Attest: this.type.types
        }
      },
      signer
    );

    const { verifyOnchain } = { ...DEFAULT_OFFCHAIN_ATTESTATION_OPTIONS, ...options };
    if (verifyOnchain) {
      try {
        const { schema, recipient, expirationTime, revocable, data } = params;

        // Verify the offchain attestation onchain by simulating a contract call to attest. Since onchain verification
        // makes sure that any referenced attestations exist, we will set refUID to ZERO_BYTES32.
        await this.eas.contract.attest.staticCall(
          { schema, data: { recipient, expirationTime, revocable, refUID: ZERO_BYTES32, data, value: 0 } },
          { from: signer }
        );
      } catch (e: unknown) {
        throw new Error(`Unable to verify offchain attestation with: ${e}`);
      }
    }

    return {
      ...signedRequest,
      uid
    };
  }

  public verifyOffchainAttestationSignature(attester: string, request: SignedOffchainAttestation): boolean {
    return (
      request.uid === Offchain.getOffchainUID(request.message) &&
      this.verifyTypedDataRequestSignature(attester, request)
    );
  }

  public static getOffchainUID(params: OffchainAttestationParams): string {
    return getOffchainUID(
      params.version ?? LEGACY_OFFCHAIN_ATTESTATION_VERSION,
      params.schema,
      params.recipient,
      params.time,
      params.expirationTime,
      params.revocable,
      params.refUID,
      params.data
    );
  }
}
