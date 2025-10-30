pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RealEstateBondFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Batch {
        bool exists;
        bool closed;
    }
    mapping(uint256 => Batch) public batches;

    euint32 internal totalEncryptedValue;
    euint32 internal totalEncryptedShares;
    mapping(uint256 => euint32) public batchEncryptedValue;
    mapping(uint256 => euint32) public batchEncryptedShares;
    mapping(uint256 => mapping(address => euint32)) public providerEncryptedValue;
    mapping(uint256 => mapping(address => euint32)) public providerEncryptedShares;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedValueCiphertext, uint256 encryptedSharesCiphertext);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 totalValue, uint32 totalShares);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchDoesNotExist();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    constructor() {
        owner = msg.sender;
        cooldownSeconds = 60;
        _initIfNeeded();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batches[batchId].exists) revert InvalidBatch();
        batches[batchId] = Batch({ exists: true, closed: false });
        emit BatchOpened(batchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (!batches[batchId].exists) revert BatchDoesNotExist();
        if (batches[batchId].closed) revert BatchClosed();
        batches[batchId].closed = true;
        emit BatchClosed(batchId);
    }

    function submitData(
        uint256 batchId,
        uint32 value,
        uint32 shares
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[batchId].exists) revert BatchDoesNotExist();
        if (batches[batchId].closed) revert BatchClosed();

        lastSubmissionTime[msg.sender] = block.timestamp;

        _initIfNeeded();
        euint32 encryptedValue = FHE.asEuint32(value);
        euint32 encryptedShares = FHE.asEuint32(shares);

        providerEncryptedValue[batchId][msg.sender] = encryptedValue;
        providerEncryptedShares[batchId][msg.sender] = encryptedShares;

        batchEncryptedValue[batchId] = batchEncryptedValue[batchId].add(encryptedValue);
        batchEncryptedShares[batchId] = batchEncryptedShares[batchId].add(encryptedShares);

        totalEncryptedValue = totalEncryptedValue.add(encryptedValue);
        totalEncryptedShares = totalEncryptedShares.add(encryptedShares);

        emit DataSubmitted(msg.sender, batchId, encryptedValue, encryptedShares);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[batchId].exists) revert BatchDoesNotExist();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        bytes32 stateHash = _hashCiphertexts(batchId);
        uint256 requestId = FHE.requestDecryption(_getCiphertexts(batchId), this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        DecryptionContext memory ctx = decryptionContexts[requestId];

        bytes32 currentHash = _hashCiphertexts(ctx.batchId);
        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        (uint32 totalValue, uint32 totalShares) = abi.decode(cleartexts, (uint32, uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalValue, totalShares);
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized(totalEncryptedValue)) {
            totalEncryptedValue = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(totalEncryptedShares)) {
            totalEncryptedShares = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 val) internal pure {
        if (!FHE.isInitialized(val)) revert("FHE value not initialized");
    }

    function _getCiphertexts(uint256 batchId) internal view returns (bytes32[] memory cts) {
        cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(batchEncryptedValue[batchId]);
        cts[1] = FHE.toBytes32(batchEncryptedShares[batchId]);
    }

    function _hashCiphertexts(uint256 batchId) internal view returns (bytes32) {
        bytes32[] memory cts = _getCiphertexts(batchId);
        return keccak256(abi.encode(cts, address(this)));
    }
}