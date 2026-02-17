import base58 from "bs58";
import BN from "bn.js";

export function getMonthName(idx) {
    const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    return monthNames[idx];
}

export function parseCid(cid) {
    return {
        geohash: cid.substring(0, 5),
        digest:
            "0x" +
            Buffer.from(base58.decode(cid.substring(5, 11))).toString("hex"),
    };
}

export function getRandomPassword() {
    var chars =
        "0123456789abcdefghijklmnopqrstuvwxyz!@#$%^&*()ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    var passwordLength = 12;
    var password = "";
    for (var i = 0; i < passwordLength; i++) {
        var randomNumber = Math.floor(Math.random() * chars.length);
        password += chars.substring(randomNumber, randomNumber + 1);
    }
    return password;
}


export function mapRescueCids(cid, blockNumber) {
    if(cid !== 'u0qj944rhWE') return cid
    let newCid = 'u0qj944rhWE'
    if(blockNumber < 1111286) newCid = 'u0qj9QqA2Q'
    if(blockNumber < 806355) newCid = 'u0qj92QX9PQ'
    return newCid
}

export function reduceObjects(objectsList) {
    // Use reduce to iterate over the objectsList
    return objectsList.reduce((result, currentObject) => {
      // Iterate over the keys of the currentObject
      Object.keys(currentObject).forEach(key => {
        // If the key is not in the result object, initialize it with the current value
        if (!result.hasOwnProperty(key)) {
          result[key] = currentObject[key];
        } else {
          // If the key is already present, add the current value to the existing value
          result[key] += currentObject[key];
        }
      });
      return result;
    }, {});
  }

  export function toNativeDecimal(value) {
    const cleanedValue = value.toString().replace(/,/g, '');
    const bnValue = new BN(cleanedValue, 10);
    const divisor = new BN('1000000000000', 10);
    const { div: quotient, mod: remainder } = bnValue.divmod(divisor);
    // Convert quotient and remainder to strings
    const quotientStr = quotient.toString(10);
    const remainderStr = remainder.toString(10).padStart(12, '0');
    // Combine quotient and remainder to form a decimal number
    return parseFloat(`${quotientStr}.${remainderStr}`);
  }
